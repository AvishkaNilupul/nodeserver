# Admin panel mobile responsiveness fix

Replace these 3 files in /var/www/redeemer/nodeserver, then reload (no restart
needed — they are static files, but a hard refresh / cache clear on the phone helps):

- public/admin-nav.js   (adds a hamburger top bar + slide-in nav drawer on phones — applies to EVERY admin page)
- public/admin.html      (Inbox: list -> chat master/detail, a Back button, and horizontally scrollable quick-reply chips)
- admin-pages/orders.html (Orders: 2x2 stat cards, stacked search/filters, horizontally scrollable table)

Nothing else changed. No new dependencies. Desktop layout is unchanged
(all new rules are inside @media (max-width: 768px)).

## What you get on mobile (<=768px wide)
- Left sidebar is hidden and opens from a hamburger button in a new top bar.
- Inbox shows the conversation list full-width; tapping a customer opens the
  chat full-width with a "<" Back button to return to the list.
- Quick-message chips (Welcome / Resend credentials / ...) are now a single
  swipeable row instead of being squeezed/wrapped.
- Orders stats become a 2x2 grid, search + filter buttons stack and are
  full-width / easy to tap, and the orders table scrolls sideways.
