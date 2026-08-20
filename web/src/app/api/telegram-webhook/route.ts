import { webhookCallback } from 'grammy';
import { bot } from '@/lib/bot';

export const POST = webhookCallback(bot, 'std/http');
