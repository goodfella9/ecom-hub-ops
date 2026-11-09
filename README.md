# Ecom Hub Ops

Private multi-store dashboard and Claude connector for Cover My Plate, My MVP Card and Arca Gear.

- **Web app** (Vite + React, on Vercel at ecomhubops.com): live overview, approvals, stores, and the OAuth sign-in page claude.ai uses (`/oauth/consent`).
- **Backend** (Supabase project `rvhjfxzwxidzcdbtbxcg`): edge functions in `supabase/functions/`
  - `mcp`: the Claude connector (OAuth 2.1 via Supabase Auth; admins only)
  - `overview`: live numbers per store (Shopify) + Meta spend (Windsor.ai)
  - `changes`: approve or reject staged changes
  - `store-health`: checks each store's Shopify app
- **Secrets** (Supabase → Edge Functions → Secrets, never in code): `SHOP_<KEY>_CLIENT_ID`, `SHOP_<KEY>_CLIENT_SECRET` per store, `WINDSOR_API_KEY`.
- **Adding a store**: Stores page → Add a store, create that store's Shopify Dev Dashboard app, add its two secrets, Run check.
