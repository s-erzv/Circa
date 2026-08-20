import { bot } from '../src/lib/bot';

console.log('Starting Telegram Bot in Long Polling mode...');
bot.start({
  onStart: (botInfo) => {
    console.log(`Bot started as @${botInfo.username}`);
  }
});
