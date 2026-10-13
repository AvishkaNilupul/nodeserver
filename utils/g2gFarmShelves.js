// Where a rent-farm ("Automatic Farming") offer is filed on G2G, per game.
//
// A Game Items offer needs the game's category fields (Platform, Server, Item
// Type …) and G2G rejects a create without them. The connector copies them from
// one of OUR OWN offers of that game (g2gAttributesFromOwnOffers), which has
// two holes for a farming window:
//
//   * a game we have never listed has nothing to copy, so it could not be
//     listed at all (76 of 83 farm games in September);
//   * "one of our offers" is whichever the list returns first. In a game where
//     we also sell bundles that can be a bundle's shelf — Rocket League has one
//     filed under "Wheels · Crimson" — and a farming window would follow it.
//
// So the shelf is written down here, per brand, and the farm publisher uses it
// before it looks at our own offers. Each one is the shelf that game's Twitch
// Drops buyers actually use: read from G2G's public offer search on 2026-10-13
// (every offer with "twitch" in it, weighted by G2G's own "sold" counter per
// offer) and named with G2G's public category list
// (GET sls.g2g.com/offer/keyword_relation/collection?relation_id=…, no login).
// Where our own offers already sat on a sensible shelf it is that one.
//
// Nothing here is a guess and nothing is approximated: a brand that is not in
// the table falls back to the connector's own rule, and an id G2G has since
// retired makes the create fail loudly instead of filing the offer elsewhere.
// Path of Exile 2's "Server" is the current league — move it when the league
// changes. The Quinfall is not here on purpose: other sellers have offers in
// it (Server: Chicago - US · Item Type: Others), but G2G answers our create
// with 400 "product is not found" (2026-10-13), so there is nothing to file.
const FARM_SHELVES = {
  // Rust — Platform: PC · Item Type: Twitch Drops
  lgc_game_24849: {
    game: "Rust",
    relationId: "b1c87f64-2ae9-46bd-bffa-b1a69df749be",
    fields: [
      { collection: "lgc_24849_platform", dataset: "lgc_24849_platform_45117", label: "Platform", value: "PC" },
      { collection: "dd656b0a", dataset: "2f7855bf", label: "Item Type", value: "Twitch Drops" },
    ],
  },
  // Warframe — Server: PC · Item Type: Twitch Drops
  lgc_game_23657: {
    game: "Warframe",
    relationId: "3aef9d99-6ab1-4b35-b25f-db42e6f898f5",
    fields: [
      { collection: "lgc_23657_server", dataset: "lgc_23657_server_25179", label: "Server", value: "PC" },
      { collection: "lgc_23657_item_type", dataset: "lgc_23657_item_type_52210", label: "Item Type", value: "Twitch Drops" },
    ],
  },
  // Path of Exile 2 — Server: Runes of Aldur Standard · Item Types: Twitch Drops
  lgc_game_27013: {
    game: "Path of Exile 2",
    relationId: "ad390f71-a4be-4bff-a600-bad9040945b7",
    fields: [
      { collection: "lgc_27013_platform", dataset: "lgc_27013_platform_62230", label: "Server", value: "Runes of Aldur Standard" },
      { collection: "d8bb6ca5", dataset: "25c947d6", label: "Item Types", value: "Twitch Drops" },
    ],
  },
  // THE FINALS — Platform: PC · Item Type: Others
  lgc_game_32786: {
    game: "THE FINALS",
    relationId: "b4c4d739-6db4-4831-832c-fd756dce9f4a",
    fields: [
      { collection: "lgc_32786_platform", dataset: "lgc_32786_platform_49461", label: "Platform", value: "PC" },
      { collection: "462d4b1a", dataset: "31d604dd", label: "Item Type", value: "Others" },
    ],
  },
  // Dead by Daylight — Platform: PC
  lgc_game_25227: {
    game: "Dead by Daylight",
    relationId: "f16e9914-2423-48e4-9701-bec4d3a0ced1",
    fields: [
      { collection: "lgc_25227_platform", dataset: "lgc_25227_platform_28602", label: "Platform", value: "PC" },
    ],
  },
  // Marvel Rivals — Platform: PC · Item Type: Twitch Drops
  lgc_game_34430: {
    game: "Marvel Rivals",
    relationId: "a9cfb251-0cca-460f-a144-485f1b67e20b",
    fields: [
      { collection: "lgc_34430_server", dataset: "lgc_34430_server_52561", label: "Platform", value: "PC" },
      { collection: "8ff086db", dataset: "9870b28a", label: "Item Type", value: "Twitch Drops" },
    ],
  },
  // Sea of Thieves — Server: All Server
  lgc_game_24939: {
    game: "Sea of Thieves",
    relationId: "387e34be-8e68-402d-8802-855e6d3b5221",
    fields: [
      { collection: "lgc_24939_server", dataset: "lgc_24939_server_27771", label: "Server", value: "All Server" },
    ],
  },
  // Escape from Tarkov — Server: [PC] PvP - Permanent · Item Type: Bundles
  lgc_game_24640: {
    game: "Escape from Tarkov",
    relationId: "597ba86f-3da5-464d-998c-543ba8786f61",
    fields: [
      { collection: "16f599a3", dataset: "d5eb6c82", label: "Server", value: "[PC] PvP - Permanent" },
      { collection: "0e9cd1b3", dataset: "55dd9e99", label: "Item Type", value: "Bundles" },
    ],
  },
  // Rocket League — Item Type: Others · Platform: PC · Colors: Default · Rarity: Default
  lgc_game_23797: {
    game: "Rocket League",
    relationId: "4707f95e-9814-4ee3-8f29-dff5c19388bd",
    fields: [
      { collection: "lgc_23797_item_type", dataset: "lgc_23797_item_type_25308", label: "Item Type", value: "Others" },
      { collection: "lgc_23797_server", dataset: "lgc_23797_server_25299", label: "Platform", value: "PC" },
      { collection: "lgc_23797_gender", dataset: "lgc_23797_gender_41596", label: "Colors", value: "Default" },
      { collection: "lgc_23797_race", dataset: "lgc_23797_race_41610", label: "Rarity", value: "Default" },
    ],
  },
  // Brawlhalla — Platform: PC · Item Type: Others
  lgc_game_24929: {
    game: "Brawlhalla",
    relationId: "fcf9497c-e411-4af5-8fa8-cbacd0ee25d5",
    fields: [
      { collection: "lgc_24929_platform", dataset: "lgc_24929_platform_27756", label: "Platform", value: "PC" },
      { collection: "90b5080f", dataset: "68cfd59f", label: "Item Type", value: "Others" },
    ],
  },
  // Black Desert — Item Type: Others · Server: Europe
  lgc_game_23306: {
    game: "Black Desert",
    relationId: "7c75f774-d739-4ee5-b17a-a214815a7c7c",
    fields: [
      { collection: "lgc_23306_item_type", dataset: "lgc_23306_item_type_23956", label: "Item Type", value: "Others" },
      { collection: "lgc_23306_server", dataset: "lgc_23306_server_25697", label: "Server", value: "Europe" },
    ],
  },
  // Halo Infinite — Platform: PC · Item Type: Others
  lgc_game_30075: {
    game: "Halo Infinite",
    relationId: "b04d2bb6-eaa9-4039-a427-9f8af986be13",
    fields: [
      { collection: "lgc_30075_platform", dataset: "lgc_30075_platform_44311", label: "Platform", value: "PC" },
      { collection: "lgc_30075_item_type", dataset: "lgc_30075_item_type_47279", label: "Item Type", value: "Others" },
    ],
  },
  // Albion Online — Server: Albion Asia
  lgc_game_21695: {
    game: "Albion Online",
    relationId: "baebc0d0-3cfb-42aa-ba91-6a7df6354ba0",
    fields: [
      { collection: "lgc_21695_faction", dataset: "lgc_21695_faction_47885", label: "Server", value: "Albion Asia" },
    ],
  },
  // Hunt: Showdown 1896 — this game asks for no category field
  lgc_game_24901: {
    game: "Hunt: Showdown 1896",
    relationId: "f1ecdb7f-b23f-4253-a39c-c2fd19eb6fa5",
    fields: [
    ],
  },
  // Palia — Server: Main Server · Item Type: Others
  lgc_game_32001: {
    game: "Palia",
    relationId: "2ef6df64-22ec-4efa-af64-2ee97f8ba1ea",
    fields: [
      { collection: "lgc_32001_server", dataset: "lgc_32001_server_47945", label: "Server", value: "Main Server" },
      { collection: "65a25804", dataset: "9b54d896", label: "Item Type", value: "Others" },
    ],
  },
  // Arena Breakout: Infinite — Platform: PC · Item Type: Others
  lgc_game_33715: {
    game: "Arena Breakout: Infinite",
    relationId: "a7cfc09e-5ce7-4750-a6b6-c951240d99ec",
    fields: [
      { collection: "lgc_33715_platform", dataset: "lgc_33715_platform_51750", label: "Platform", value: "PC" },
      { collection: "08b42c15", dataset: "bd9f92c6", label: "Item Type", value: "Others" },
    ],
  },
};

// The shape g2gPublish takes: { relationId, attributes, collectionTree }, plus
// `text` for logs. null when the brand has no hand-checked shelf.
function farmShelfForBrand(brandId) {
  const s = FARM_SHELVES[String(brandId || "")];
  if (!s) return null;
  return {
    relationId: s.relationId,
    attributes: s.fields.map((f) => ({ collection_id: f.collection, dataset_id: f.dataset, value: f.value })),
    collectionTree: s.fields.map((f) => f.collection),
    text: s.fields.map((f) => f.label + ": " + f.value).join(" · ") || "no category field",
  };
}

module.exports = { FARM_SHELVES, farmShelfForBrand };
