import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import crypto from "crypto";
import { VEHICLES, computePricingEstimate, areEstimatesConsistent } from "./pricing.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 8080);
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const bookings = [];
const pricingMetrics = [];
const adminTokens = new Set();

const requireAdmin = (req, res, next) => {
  const auth = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "").trim();
  if (!token || !adminTokens.has(token)) return res.status(401).json({ error: "Unauthorized" });
  next();
};

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, stripe: !!stripe, vehicles: VEHICLES.length });
});

app.get("/api/bookings-public", (req, res) => {
  const months = Number(req.query.months || 6);
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth() + months, now.getDate());
  const ranges = bookings
    .filter((b) => b.status === "CONFIRMED")
    .filter((b) => new Date(b.endDate) >= now && new Date(b.startDate) <= end)
    .map((b) => ({ vehicleId: b.vehicleId, startDate: b.startDate, endDate: b.endDate }));
  res.json({ bookings: ranges });
});

app.post("/api/pricing-metrics", (req, res) => {
  pricingMetrics.push({ ...req.body, receivedAt: new Date().toISOString() });
  if (pricingMetrics.length > 5000) pricingMetrics.shift();
  res.status(202).json({ accepted: true });
});

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Mot de passe incorrect." });
  const token = crypto.randomBytes(24).toString("hex");
  adminTokens.add(token);
  res.json({ token });
});

app.get("/api/admin/bookings", requireAdmin, (_req, res) => {
  res.json({ bookings });
});

app.get("/api/admin/pricing-metrics", requireAdmin, (_req, res) => {
  res.json({ metrics: pricingMetrics.slice(-1000) });
});

app.post("/api/checkout", async (req, res) => {
  try {
    const { vehicleId, startDate, endDate, customer, notes, pricingEstimate } = req.body || {};
    if (!vehicleId || !startDate || !endDate || !customer?.name || !customer?.email || !customer?.phone) {
      return res.status(400).json({ error: "Payload invalide." });
    }

    const vehicle = VEHICLES.find((v) => v.id === Number(vehicleId));
    if (!vehicle) return res.status(404).json({ error: "Véhicule introuvable." });

    const serverEstimate = computePricingEstimate({ startDate, endDate, vehicle, bookings });

    if (!areEstimatesConsistent(pricingEstimate, serverEstimate)) {
      return res.status(409).json({
        error: "Écart de tarification détecté. Veuillez rafraîchir et réessayer.",
        pricingEstimateServer: serverEstimate
      });
    }

    const bookingId = crypto.randomUUID();
    const baseBooking = {
      bookingId,
      vehicleId: vehicle.id,
      vehicleName: vehicle.name,
      customerName: customer.name,
      customerEmail: customer.email,
      customerPhone: customer.phone,
      startDate,
      endDate,
      totalPaidEUR: serverEstimate.finalPrice,
      notes: notes || "",
      status: "PENDING",
      createdAt: new Date().toISOString()
    };

    let url = `${APP_BASE_URL}/success?bookingId=${bookingId}`;

    if (stripe) {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        success_url: process.env.STRIPE_SUCCESS_URL || `${APP_BASE_URL}/success?bookingId=${bookingId}`,
        cancel_url: process.env.STRIPE_CANCEL_URL || `${APP_BASE_URL}/cancel?bookingId=${bookingId}`,
        customer_email: customer.email,
        line_items: [
          {
            price_data: {
              currency: "eur",
              product_data: { name: `Location ${vehicle.name}`, description: `${startDate} → ${endDate}` },
              unit_amount: serverEstimate.finalPrice * 100
            },
            quantity: 1
          }
        ],
        metadata: {
          bookingId,
          vehicleId: String(vehicle.id),
          startDate,
          endDate,
          customerName: customer.name
        }
      });
      url = session.url;
    } else {
      // mode backend-ready sans clé Stripe: on confirme en simulation locale
      baseBooking.status = "CONFIRMED";
      bookings.push(baseBooking);
    }

    res.json({ url, pricingEstimateServer: serverEstimate, bookingId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur checkout." });
  }
});

app.get("/success", (req, res) => {
  res.type("html").send(`<h1>Paiement validé</h1><p>Booking: ${req.query.bookingId || "-"}</p>`);
});

app.get("/cancel", (req, res) => {
  res.type("html").send(`<h1>Paiement annulé</h1><p>Booking: ${req.query.bookingId || "-"}</p>`);
});

app.listen(PORT, () => {
  console.log(`RIIDE backend running on ${APP_BASE_URL}`);
});
