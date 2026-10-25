/* SOOP farm — Listings tab: every farm code as game cards — where it is
   listed, what is on sale, what sold where (public/shop-board/board.js,
   docs/code-shop/08-LISTINGS-BOARD.md). Opens on the SOOP farm; its chips
   switch to CHZZK or both. */
(function () {
  "use strict";
  if (window.ShopBoard) window.ShopBoard.mountTab(Soop, { farm: "soop" });
})();
