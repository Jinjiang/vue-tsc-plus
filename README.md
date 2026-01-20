# vue-tsc-plus

A thin wrapper around `vue-tsc` with room for extra extensions. Exposes both a CLI (`vue-tsc-plus`) and a tiny Node API. Besides `vue-tsc`, it can compile `.vue` files into JavaScript and CSS files.

## Install

```bash
pnpm add -D vue-tsc-plus
```

## CLI

The CLI mirrors `vue-tsc` and forwards all arguments:

```bash
vue-tsc-plus -p tsconfig.json
```

Any flags accepted by `vue-tsc` are supported. Additional flags may be added later.

## Node API

```ts
import { run } from 'vue-tsc-plus'

run()
```
