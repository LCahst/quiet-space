// Quiet Space website: sends www.quietspace.fun to quietspace.fun, then serves the built site files.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== "quietspace.fun" && url.hostname.endsWith("quietspace.fun")) {
      url.hostname = "quietspace.fun";
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
