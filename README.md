# Wheel Ads site

The folder is deployable as a Vercel project root. It serves `index.html` and
the serverless inventory endpoint at `/api/inventory`.

Set these Vercel environment variables:

- `GOOGLE_SHEETS_ID` — spreadsheet with `Tires` and `Диски` sheets.
- `GOOGLE_CREDENTIALS` — service account JSON on one line. Share the spreadsheet
  with that service account as a viewer.

The inventory API reads only public stock (`lager` / `Доступно`), keeps the
inventory in server memory for two minutes and sends 24-item pages. Vercel's
edge cache keeps each page for one minute with stale-while-revalidate for five
minutes. The browser keeps up to 60 recently used pages and displays a cached
page immediately while it refreshes. More items load near the scroll position.

By default, winter R16 and R18 tires are ranked first. The browser counts
season/radius searches locally and sends only those category priorities (never
an identifier) so later catalog loads can put frequently searched sizes first.

`vercel.json` caches the catalog shell and script at the edge. The browser
cancels obsolete requests when the season or search changes, and cards outside
the visible area use browser content visibility to reduce layout and paint work.
Season and rim diameter filters are available before inventory finishes loading
and can be combined in either order. Selecting a diameter filters tires and
wheels together; the text field remains available for size, brand, model, and ID.
