import { Hono } from 'hono';
import type { AppEnv } from './env';
import { health } from './routes/health';
import { book } from './routes/book';
import { event } from './routes/event';

const app = new Hono<AppEnv>();

app.route('/', health);
app.route('/', book);
app.route('/', event);

export default app;
