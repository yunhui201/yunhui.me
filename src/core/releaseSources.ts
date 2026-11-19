/** Public release endpoints are application defaults, not user-supplied update servers. */
export const RELEASE_REPOSITORY = 'yunhui201/yunhui.me';
export const GITHUB_RELEASE_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
export const GITHUB_RELEASE_PAGE = `https://github.com/${RELEASE_REPOSITORY}/releases/latest`;
export const OFFICIAL_UPDATE_URL = 'https://yunhui.me/pub.php?action=update';
export const OFFICIAL_SITE_ORIGIN = 'https://yunhui.me';
export const OFFICIAL_CATALOG_URL = `${OFFICIAL_SITE_ORIGIN}/pub.php?action=catalog`;
