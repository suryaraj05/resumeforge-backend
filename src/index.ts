import dotenv from 'dotenv';

dotenv.config();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import { warmGeminiModelSelection } from './lib/geminiModels';
import authRouter from './routes/auth';
import profileRouter from './routes/profile';
import groupsRouter from './routes/groups';
import resumeRouter from './routes/resume';
import chatRouter from './routes/chat';
import jobsRouter from './routes/jobs';
import applicationsRouter from './routes/applications';
import interviewCareerRouter from './routes/interviewCareer';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(helmet());

const corsOrigins = (process.env.ALLOWED_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins,
  credentials: true,
}));
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

function healthPayload(_req: express.Request, res: express.Response): void {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
}
app.get('/health', healthPayload);
/** Same as /health — Vercel middleware proxies /api/* to the API host with path preserved. */
app.get('/api/health', healthPayload);

app.use('/api/auth', authRouter);
app.use('/api/profile', profileRouter);
app.use('/api/groups', groupsRouter);
app.use('/api/resume', resumeRouter);
app.use('/api/chat', chatRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/applications', applicationsRouter);
app.use('/api/interview', interviewCareerRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

async function start(): Promise<void> {
  await warmGeminiModelSelection();
  const port = Number(PORT) || 4000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`ResumeForge API running on http://0.0.0.0:${port}`);
  });
}

start().catch((err) => {
  console.error('Failed to start API:', err);
  process.exit(1);
});

export default app;
