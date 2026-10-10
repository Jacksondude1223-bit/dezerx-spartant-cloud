// A Spartan licence is issued per domain by DezerX and arrives with the provisioning
// request, because the master website issues it at purchase. Nothing here mints or
// sub-licenses anything; the node only carries the key through to the tenant's
// environment, where the application verifies it against the vendor itself.
const PRODUCTS = {SPARTANSTARTER_: '1', SPARTANCLOUDPLUS_: '9', SPARTANPROFESSIONAL_: '5', SPARTANULTIMATE_: '6', SPARTANDEV_: '6'};

export function productId(key) {
  const prefix = Object.keys(PRODUCTS).find(candidate => typeof key === 'string' && key.startsWith(candidate));
  if (!prefix) throw new Error('invalid_license_key');
  return PRODUCTS[prefix];
}
export function validLicenseKey(key) {
  // The charset matches what the vendor's own download client accepts, so a key that
  // would be rejected there is refused before a tenant is built around it.
  if (typeof key !== 'string' || key.length < 16 || key.length > 256 || !/^[A-Za-z0-9_-]+$/.test(key)) return false;
  try { productId(key); return true; } catch { return false; }
}
