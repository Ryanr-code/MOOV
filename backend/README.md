# RIIDE Backend (backend-ready)

Backend Express prêt pour brancher Stripe + cohérence tarifaire front/back + métriques de conversion par tranche de prix.

## Installation

```bash
cd backend
npm install
cp .env.example .env
npm run start
```

## Endpoints

- `GET /api/health`
- `GET /api/bookings-public?months=6`
- `POST /api/pricing-metrics`
- `POST /api/checkout`
- `POST /api/admin/login`
- `GET /api/admin/bookings` (Bearer token)
- `GET /api/admin/pricing-metrics` (Bearer token)

## Cohérence front/back anti-écart

Le backend recalcule systématiquement le prix via `computePricingEstimate(...)` et compare la proposition client (`pricingEstimate`).

- si mismatch => `409` + `pricingEstimateServer`
- si cohérent => création session Stripe (ou mode simulation si clé Stripe absente)

## Stripe

Ajoutez `STRIPE_SECRET_KEY` dans `.env`.

En mode sans clé Stripe, l'API retourne une URL locale de succès et confirme la réservation en simulation.
