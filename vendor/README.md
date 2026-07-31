# Vendored browser dependencies

These files are committed so the static app can start when third-party CDNs are unavailable.

- `leaflet-1.9.4.*` — Leaflet 1.9.4, BSD-2-Clause, https://leafletjs.com/
- `d3-v7.min.js` — D3 v7, ISC, https://d3js.org/
- `supabase-js-2.111.0.min.js` — Supabase JavaScript 2.111.0, MIT, https://github.com/supabase/supabase-js

When updating a dependency, replace the corresponding files, run the full test suite, and increment the Dumanaltı build/cache number.
