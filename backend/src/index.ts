import { run, type Role } from './bootstrap.js';

const role = (process.env.PROCESS_ROLE ?? 'all') as Role;
run(['api', 'worker', 'all'].includes(role) ? role : 'all');
