// The slash commands, as Discord wants them. scripts/register.mjs sends them to Discord.

const region = (required) => ({
  type: 3,
  name: "region",
  description: "EU or NA",
  required,
  choices: [
    { name: "EU", value: "eu" },
    { name: "NA", value: "na" },
  ],
});

const DAY_CHOICES = ["today", "tomorrow", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => ({
  name: d[0].toUpperCase() + d.slice(1),
  value: d,
}));

// /host, /setup and /leaderboard are staff-only: the bot checks for the STAFF_ROLE_ID role
// (src/index.js). Discord still lists them for everyone unless an admin hides them in
// Server Settings → Integrations → the bot.

export const commands = [
  {
    name: "leaderboard",
    dm_permission: false,
    description: "Staff: post a one-off leaderboard (top 75, 15 a page)",
    options: [
      { ...region(false), description: "EU or NA (EU if left out)" },
      { type: 4, name: "page", description: "Page 1–5", min_value: 1, max_value: 5, required: false },
    ],
  },
  {
    name: "stats",
    description: "A player's ranked stats from genjiball.us",
    options: [
      { type: 3, name: "player", description: "Player name", required: true, autocomplete: true },
      { ...region(false), description: "EU or NA (the one they're rated in if left out)" },
    ],
  },
  {
    name: "setup",
    description: "Staff: set up the bot in this server",
    dm_permission: false,
    options: [
      {
        type: 1,
        name: "leaderboard",
        description: "Post a leaderboard that keeps itself up to date in a channel",
        options: [
          {
            type: 7,
            name: "channel",
            description: "Where to post it (this channel if left out)",
            required: false,
            channel_types: [0, 5],
          },
        ],
      },
    ],
  },
  {
    name: "host",
    description: "Staff: tournament sign-ups",
    dm_permission: false,
    options: [
      {
        type: 1,
        name: "tournament",
        description: "Post a tournament sign-up players react to",
        options: [
          region(true),
          { type: 3, name: "day", description: "The day it's on", required: true, choices: DAY_CHOICES },
          {
            type: 3,
            name: "time",
            description: "Start time in the region's time zone, like 21:00 or 9pm (default 21:00)",
            required: false,
          },
          { type: 3, name: "name", description: "Tournament name (default: EU/NA Weekly Tournament)", required: false, max_length: 100 },
        ],
      },
      {
        type: 1,
        name: "cancel",
        description: "Cancel the next tournament in a region",
        options: [region(true)],
      },
    ],
  },
];
