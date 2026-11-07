// A plugin node: one function, called once per firing.
// ctx.inputs  the values on the input sockets, by letter (numbers, lists and objects come back typed)
// ctx.settings  what the user set in the panel (the manifest's "fields")
// Return the value for the "out" socket, or { out: value } for named outputs.
// See HOST_API.md for everything ctx offers.
module.exports = {
  async run(ctx) {
    const text = String(ctx.inputs.A ?? '');
    const mode = ctx.settings.mode || 'upper';
    await ctx.progress(`changing "${text.slice(0, 30)}"`);
    const changed = mode === 'lower' ? text.toLowerCase() : text.toUpperCase();
    return changed + (ctx.settings.suffix || '');
  },
};
