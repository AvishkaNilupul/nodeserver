const Inventory = require("../models/Inventory");

async function loadInventory() {
  const items = await Inventory.find().sort({ createdAt: -1 }).lean();
  return items.map(({ _id, ...rest }) => ({ id: _id.toString(), ...rest }));
}

function addInventory(category, username, password) {
  return Inventory.create({
    category,
    username,
    password,
    used: false,
    usedAt: null,
  });
}

function setUsed(id, used) {
  return Inventory.findByIdAndUpdate(
    id,
    { $set: { used, usedAt: used ? new Date() : null } },
    { new: true }
  );
}

function deleteInventory(id) {
  return Inventory.deleteOne({ _id: id });
}

module.exports = {
  loadInventory,
  addInventory,
  setUsed,
  deleteInventory,
};