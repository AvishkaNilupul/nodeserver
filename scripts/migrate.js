/**
 * One-time migration: moves the legacy flat-file JSON data into MongoDB.
 *
 * Usage:
 *   node scripts/migrate.js
 *
 * - Reads orderIds.json / messages.json / items.json / inventory.json from the
 *   project root (falls back to the utils/ copies).
 * - Backfills missing `sellerId` on messages by matching userId -> the order
 *   whose gamerTag equals that userId.
 * - Safe to re-run: existing rows are detected and skipped.
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

require("dotenv").config();

const Order = require("../models/Order");
const Message = require("../models/Message");
const Item = require("../models/Item");
const Inventory = require("../models/Inventory");

const root = path.join(__dirname, "..");

function readJson(...candidates) {
  for (const rel of candidates) {
    const file = path.join(root, rel);
    if (fs.existsSync(file)) {
      try {
        return { data: JSON.parse(fs.readFileSync(file, "utf8")), file };
      } catch (err) {
        console.error(`Could not parse ${file}:`, err.message);
      }
    }
  }
  return { data: [], file: null };
}

function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function migrateOrders() {
  const { data, file } = readJson("orderIds.json", "utils/orderIds.json");
  if (!file) return console.log("orders: no source file, skipped");

  let inserted = 0;
  for (const o of data) {
    if (!o.orderId) continue;
    const exists = await Order.findOne({
      orderId: o.orderId,
      sellerId: o.sellerId || { $exists: true },
    });
    if (exists) continue;

    await Order.create({
      sellerId: o.sellerId || "unknown",
      sellerName: o.sellerName || "",
      orderId: o.orderId,
      username: o.username || "",
      password: o.password || "",
      used: !!o.used,
      gamerTag: o.gamerTag || null,
      usedAt: toDate(o.usedAt),
      chatToken: o.chatToken || null,
      createdAt: toDate(o.createdAt) || undefined,
    });
    inserted += 1;
  }
  console.log(`orders: ${inserted} inserted (from ${file})`);
}

async function buildGamerTagSellerMap() {
  const orders = await Order.find(
    { gamerTag: { $ne: null } },
    { gamerTag: 1, sellerId: 1 }
  ).lean();
  const map = new Map();
  for (const o of orders) map.set(o.gamerTag, o.sellerId);
  return map;
}

async function migrateMessages() {
  const { data, file } = readJson("messages.json", "utils/messages.json");
  if (!file) return console.log("messages: no source file, skipped");

  const sellerMap = await buildGamerTagSellerMap();

  let inserted = 0;
  let skippedNoSeller = 0;
  for (const m of data) {
    if (!m.userId || !m.message) continue;

    const sellerId = m.sellerId || sellerMap.get(m.userId);
    if (!sellerId) {
      skippedNoSeller += 1;
      continue;
    }

    const createdAt = toDate(m.timestamp) || toDate(m.createdAt);
    const exists = await Message.findOne({
      userId: m.userId,
      sellerId,
      message: m.message,
      ...(createdAt ? { createdAt } : {}),
    });
    if (exists) continue;

    await Message.create({
      userId: m.userId,
      sellerId,
      sender: m.sender === "admin" ? "admin" : "user",
      message: m.message,
      readByAdmin: !!m.readByAdmin,
      seen: !!m.seen,
      createdAt: createdAt || undefined,
    });
    inserted += 1;
  }
  console.log(
    `messages: ${inserted} inserted, ${skippedNoSeller} skipped (no sellerId match) (from ${file})`
  );
}

async function migrateItems() {
  const { data, file } = readJson("items.json", "utils/items.json");
  if (!file) return console.log("items: no source file, skipped");

  let inserted = 0;
  for (const i of data) {
    if (!i.category || !i.username) continue;
    const exists = await Item.findOne({
      category: i.category,
      username: i.username,
      password: i.password,
    });
    if (exists) continue;

    await Item.create({
      category: i.category,
      username: i.username,
      password: i.password,
      notes: i.notes || "",
      value: Number(i.value) || 0,
      used: !!i.used,
      usedAt: toDate(i.usedAt),
      createdAt: toDate(i.createdAt) || undefined,
    });
    inserted += 1;
  }
  console.log(`items: ${inserted} inserted (from ${file})`);
}

async function migrateInventory() {
  const { data, file } = readJson("inventory.json", "utils/inventory.json");
  if (!file) return console.log("inventory: no source file, skipped");

  let inserted = 0;
  for (const i of data) {
    if (!i.category || !i.username) continue;
    const exists = await Inventory.findOne({
      category: i.category,
      username: i.username,
      password: i.password,
    });
    if (exists) continue;

    await Inventory.create({
      category: i.category,
      username: i.username,
      password: i.password,
      used: !!i.used,
      usedAt: toDate(i.usedAt),
      createdAt: toDate(i.createdAt) || undefined,
    });
    inserted += 1;
  }
  console.log(`inventory: ${inserted} inserted (from ${file})`);
}

async function main() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required");
  }
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  await migrateOrders();
  await migrateMessages();
  await migrateItems();
  await migrateInventory();

  await mongoose.disconnect();
  console.log("Migration complete");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
