/* CHZZK farm — Listings tab: every farm code as game cards — where it is
   listed, what is on sale, what sold where (public/shop-board/board.js,
   docs/code-shop/08-LISTINGS-BOARD.md). Opens on the CHZZK farm; its chips
   switch to SOOP or both. */
(function () {
  "use strict";
  if (window.ShopBoard) window.ShopBoard.mountTab(Chzzk, { farm: "chzzk" });
})();
