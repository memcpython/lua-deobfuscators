export function removeLuaObfuscatorBanner(source) {
  const bannerPattern = /^\s*--\[\[[\s\S]*?LuaObfuscator\.com[\s\S]*?\]\]--\s*/;
  const code = source.replace(bannerPattern, "");
  return {
    code,
    removed: code !== source
  };
}
