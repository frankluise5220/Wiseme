export function generateRandomKey(length = 32) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let key = "";
  for (let i = 0; i < length; i += 1) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}
