export const DEMAND_PERIODS = [
  { name: "Vacances scolaires", start: "2026-02-14", end: "2026-03-02", category: "car", factor: 1.12 },
  { name: "Été utilitaires", start: "2026-07-01", end: "2026-08-31", category: "van", factor: 1.3 },
  { name: "Été voitures", start: "2026-07-01", end: "2026-08-31", category: "car", factor: 1.15 },
  { name: "Ponts de mai", start: "2026-05-01", end: "2026-05-11", category: "all", factor: 1.15 }
];

export const VEHICLES = [
  { id: 1, category: "particuliers", name: "Peugeot 208 GT Auto", baseWeekday: 48, baseWeekend: 58, minPrice: 42, maxPrice: 95, deposit: 1000 },
  { id: 2, category: "particuliers", name: "Volkswagen Polo 6", baseWeekday: 45, baseWeekend: 55, minPrice: 39, maxPrice: 85, deposit: 800 },
  { id: 5, category: "particuliers", name: "Volkswagen Golf 8 Auto", baseWeekday: 57, baseWeekend: 67, minPrice: 49, maxPrice: 110, deposit: 1000 },
  { id: 3, category: "utilitaires", name: "Citroën Jumpy", baseWeekday: 55, baseWeekend: 68, minPrice: 50, maxPrice: 120, deposit: 1200 },
  { id: 4, category: "utilitaires", name: "Opel Movano 12m³", baseWeekday: 63, baseWeekend: 76, minPrice: 58, maxPrice: 135, deposit: 1500 }
];

const pad2 = (n) => String(n).padStart(2, "0");
const toLocalISO = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const vehicleType = (v) => (v.category === "utilitaires" ? "van" : "car");

const getSeasonalFactor = (date, vehicle) => {
  const dayIso = toLocalISO(date);
  return DEMAND_PERIODS.filter((rule) => (rule.category === "all" || rule.category === vehicleType(vehicle)) && dayIso >= rule.start && dayIso <= rule.end)
    .reduce((acc, rule) => acc * rule.factor, 1);
};

const getBridgeAndEndMonthFactor = (date, vehicle) => {
  const day = date.getDate();
  const isLongWeekendWindow = [1, 2, 3, 4, 8, 9, 10, 11].includes(day) && date.getMonth() === 4;
  const isEndMonthMoveWindow = (day >= 27 || day <= 3) && vehicleType(vehicle) === "van";
  let factor = 1;
  if (isLongWeekendWindow) factor *= 1.12;
  if (isEndMonthMoveWindow) factor *= 1.15;
  return factor;
};

const getLastMinuteFactor = (date) => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffHours = (target - today) / (1000 * 60 * 60);
  return diffHours <= 48 ? 0.9 : 1;
};

const getRolling30OccupancyFactor = (vehicle, bookings) => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 29);

  const bookedDays = new Set();
  for (const booking of bookings) {
    if (booking.vehicleId !== vehicle.id || booking.status !== "CONFIRMED") continue;
    const bStart = new Date(booking.startDate);
    const bEnd = new Date(booking.endDate);
    const from = bStart > start ? bStart : new Date(start);
    const to = bEnd < end ? bEnd : new Date(end);
    const cursor = new Date(from);
    while (cursor <= to) {
      bookedDays.add(toLocalISO(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  const ratio = bookedDays.size / 30;
  if (ratio < 0.25) return 0.9;
  if (ratio <= 0.5) return 1;
  if (ratio <= 0.7) return 1.1;
  return 1.2;
};

export function computePricingEstimate({ startDate, endDate, vehicle, bookings }) {
  let basePrice = 0;
  let adjustedPrice = 0;
  const dailyBreakdown = [];
  const occupancyFactor = getRolling30OccupancyFactor(vehicle, bookings || []);
  const cursor = new Date(startDate);
  const end = new Date(endDate);

  while (cursor <= end) {
    const dayOfWeek = cursor.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const baseDay = isWeekend ? Number(vehicle.baseWeekend) : Number(vehicle.baseWeekday);
    const seasonalFactor = getSeasonalFactor(cursor, vehicle);
    const bridgeFactor = getBridgeAndEndMonthFactor(cursor, vehicle);
    const lastMinuteFactor = getLastMinuteFactor(cursor);

    const raw = baseDay * seasonalFactor * bridgeFactor * occupancyFactor * lastMinuteFactor;
    const clamped = clamp(raw, Number(vehicle.minPrice), Number(vehicle.maxPrice));

    basePrice += baseDay;
    adjustedPrice += clamped;
    dailyBreakdown.push({
      date: toLocalISO(cursor),
      baseDay,
      seasonalFactor,
      bridgeFactor,
      occupancyFactor,
      lastMinuteFactor,
      raw: Math.round(raw * 100) / 100,
      clamped: Math.round(clamped)
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  const finalPrice = Math.round(adjustedPrice);
  const roundedBase = Math.round(basePrice);
  return {
    basePrice: roundedBase,
    finalPrice,
    demandAdjustment: finalPrice - roundedBase,
    occupancyFactor,
    dailyBreakdown
  };
}

export function areEstimatesConsistent(clientEstimate, serverEstimate) {
  if (!clientEstimate || !serverEstimate) return false;
  if (Math.round(clientEstimate.basePrice) !== Math.round(serverEstimate.basePrice)) return false;
  if (Math.round(clientEstimate.finalPrice) !== Math.round(serverEstimate.finalPrice)) return false;

  const clientDays = Array.isArray(clientEstimate.dailyBreakdown) ? clientEstimate.dailyBreakdown : [];
  const serverDays = Array.isArray(serverEstimate.dailyBreakdown) ? serverEstimate.dailyBreakdown : [];
  if (clientDays.length !== serverDays.length) return false;

  for (let i = 0; i < clientDays.length; i++) {
    if (clientDays[i].date !== serverDays[i].date) return false;
    if (Math.round(clientDays[i].clamped) !== Math.round(serverDays[i].clamped)) return false;
  }
  return true;
}
