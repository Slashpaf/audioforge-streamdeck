# Third-party notices

The plugin distribution includes the following third-party software. Complete license texts are copied into `com.slashpaf.audioforge.sdPlugin/licenses/` and therefore ship in the OpenDeck archive.

| Component | Version | License |
| --- | --- | --- |
| `@elgato/streamdeck` | 2.0.4 | MIT |
| `@elgato/utils` | 0.4.4 | MIT |
| `@elgato/schemas` | 0.4.15 | MIT |
| `ws` | 8.21.3 | MIT |
| `zod` | 3.25.76 | MIT |
| `tslib` | 2.8.1 | 0BSD |
| `sdpi-components` | 3.0.2 | MIT |
| Lit (included in `sdpi-components`) | bundled | BSD-3-Clause |

The versions for npm dependencies are recorded in `package-lock.json`. `sdpi-components` is vendored at `com.slashpaf.audioforge.sdPlugin/ui/vendor/sdpi-components.v3.0.2.js`; its upstream source is [GeekyEggo/sdpi-components](https://github.com/GeekyEggo/sdpi-components). The bundle's header records the sdpi-components and Lit attributions.
