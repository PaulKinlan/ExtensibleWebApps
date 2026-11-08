# The plugin registry

The site's plugin registry is a folder of plugins no app links: [`packages/`](../../packages/), served at `/packages/`. A person adds any of them to any app from Customize, as they would a plugin of their own. Plugins in it can provide services, so a person can get a capability the site didn't build in without any trusted code loading at run time.

## What a person sees

Customize lists the registry under **Add a plugin**: each plugin's name, what it does and what it asks for. **Add** puts it with the person's own plugins for that app, switched off, as with any plugin they add. If it needs a service another plugin in the registry provides, that plugin is added too, and Customize says so before they click.

Try it: open any demo, open Customize, and add **World clock**. It needs the `clock` service, so **Clock** comes with it. Turn both on and a strip of clocks appears at the foot of the page.

## A package

A package is a folder `packages/<id>/` holding `<id>.js`, a plugin whose manifest `id` is the folder's name, and the files its manifest lists:

```
packages/
  index.json              the list Customize shows, made by npm run packages
  clock/clock.js          provides the clock service
  world-clock/
    world-clock.js        needs clock, draws in a place
    world-clock.html      its templates
```

[`clock.js`](../../packages/clock/clock.js) provides a service (`provides`, `ctx.provide`), and [`world-clock.js`](../../packages/world-clock/world-clock.js) says it needs it (`services: ["clock"]`). [The layers](../layers.md#plugins-that-provide-services) explains both fields.

## Adding a package

1. Make the folder, with the plugin and its files.
2. Run `npm run packages`, which reads every manifest and rewrites `packages/index.json`. The tests fail if it is out of date.
3. Check it in Customize on any demo.

A registry plugin is an ordinary sandboxed plugin. It runs in its own worker, can do only what its manifest asks for, and the person sees what that is before they turn it on.

## Limits for now

- Customize adds a plugin only from the site it is on, so the registry is the site's own `/packages/`. An app deployed on its own address ([Deploying one app](deploying-an-app.md)) has its own copy, if it was deployed with one.
- There is no versioning yet. Adding a package again replaces the person's copy, and it starts switched off again.
