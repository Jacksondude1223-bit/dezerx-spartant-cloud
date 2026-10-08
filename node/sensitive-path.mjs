export function sensitivePath(value) {
  let pathname = value.split('?')[0];
  try {
    for (let i = 0; i < 3; i++) {
      const decoded = decodeURIComponent(pathname);
      if (decoded === pathname) break;
      pathname = decoded;
    }
  } catch { return true; }
  if (/[\\\x00]/.test(pathname)) return true;
  const parts = pathname.toLowerCase().split('/');
  return parts.some(part => ['..', '.git', '.svn', '.hg', 'node_modules'].includes(part) || /^\.env(?:\.|$)/.test(part))
    || /\/vendor\/(?:autoload\.php(?:\/|$)|composer(?:\/|$))/.test(pathname.toLowerCase())
    || /\/(?:storage\/container|bootstrap\/cache|backups?)(?:\/|$)/.test(pathname.toLowerCase())
    || /\/(?:composer\.(?:json|lock)|artisan|database\.(?:sql|sqlite|sqlite3)(?:\.gz)?|app\.env|state\.json)$/.test(pathname.toLowerCase());
}
