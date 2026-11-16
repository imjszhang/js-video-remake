// Engine identifiers and the host runtime location. Kept free of project imports so
// reproduction modules can read them without pulling in the film engine.
import { fileURLToPath } from 'node:url';

export const FILM_ENGINE = 'film@1';
export const FILM_RUNTIME_VERSION = '0.3.0';
// The host's own copy of the runtime. Managed renders run these files, never the
// copies inside a project, so a project cannot change how it is rendered or checked.
export const FILM_RUNTIME_DIR = fileURLToPath(new URL('../../resources/film-runtime', import.meta.url));
