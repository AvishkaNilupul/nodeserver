function generateRedeemCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  function part(length) {
    let result = "";
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  return `${part(4)}-${part(5)}-${part(4)}-${part(4)}`;
}

module.exports = generateRedeemCode;