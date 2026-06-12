const Item = require("../models/Item");

async function loadItems() {
  const items = await Item.find().sort({ createdAt: -1 }).lean();
  return items.map(({ _id, ...rest }) => ({ id: _id.toString(), ...rest }));
}

function addItem(category, username, password, notes = "", value = 0) {
  return Item.create({
    category,
    username,
    password,
    notes,
    value: Number(value) || 0,
    used: false,
    usedAt: null,
  });
}

function deleteItem(id) {
  return Item.deleteOne({ _id: id });
}

// Atomically claims the next unused item in a category so two concurrent
// requests can never hand out the same account.
function getNextItem(category) {
  return Item.findOneAndUpdate(
    {
      category: { $regex: `^${escapeRegex(category)}$`, $options: "i" },
      used: false,
    },
    { $set: { used: true, usedAt: new Date() } },
    { new: true, sort: { createdAt: 1 } }
  ).lean();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  loadItems,
  addItem,
  deleteItem,
  getNextItem,
};