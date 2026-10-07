// The slash commands, as Discord wants them: one /gr command with everything under it.
// scripts/register.mjs sends them to Discord.
//
// Tournaments are made on genjiball.us, not here.
//
// /gr stats is for everyone. The rest is Staff only: the bot checks for the STAFF_ROLE_ID role
// (src/index.js) and answers anyone else "Only Staff can use this".

const region = (required, description = "EU or NA") => ({
  type: 3,
  name: "region",
  description,
  required,
  choices: [
    { name: "EU", value: "eu" },
    { name: "NA", value: "na" },
  ],
});

export const commands = [
  {
    name: "gr",
    description: "Genji Ball Ranked",
    contexts: [0],
    options: [
      {
        type: 1,
        name: "stats",
        description: "A player's ranked stats from genjiball.us",
        options: [
          { type: 3, name: "player", description: "Player name", required: true, autocomplete: true },
          region(false, "EU or NA (the one they're rated in if left out)"),
        ],
      },
      {
        type: 1,
        name: "leaderboard",
        description: "Staff: post a one-off leaderboard (top 75, 15 a page)",
        options: [
          region(false, "EU or NA (EU if left out)"),
          { type: 4, name: "page", description: "Page 1–5", min_value: 1, max_value: 5, required: false },
        ],
      },
      {
        type: 2,
        name: "setup",
        description: "Staff: set up the bot",
        options: [
          {
            type: 1,
            name: "leaderboard",
            description: "Staff: post a leaderboard that keeps itself up to date in a channel",
            options: [{ type: 7, name: "channel", description: "Where to post it (this channel if left out)", required: false, channel_types: [0, 5] }],
          },
        ],
      },
    ],
  },
];
