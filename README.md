# Quiet Space

Find the emptiest systems in EVE Online, using live data from CCP's ESI API.

The site shows each system's last-hour traffic, a 30-day average with weekly patterns, station services, faction warfare, pirate insurgencies, player structures, high-sec islands, ice belts, system sizes, and region maps. A **Go Loud!** button flips everything to show the busiest and most dangerous places instead, including the systems with the most ISK destroyed, and a **live kill map** shows kills across New Eden as they happen. A scheduled GitHub Action collects traffic every hour and prepares map data every day, so the site loads quickly for everyone.

## What's in this repository

- `index.html` is the main website (Quiet Space and Loud Space). You can also open it straight from your computer; it then fetches what it needs from ESI itself, and the features that rely on collected data stay hidden.
- `killmap.html` is the live kill map, in 2D and 3D, with a scrolling kill feed from zKillboard.
- `scripts/` holds the jobs the Action runs:
  - `collect-activity.mjs` records traffic hourly and builds the averages and weekly patterns.
  - `collect-isk.mjs` reads zKillboard's live kill feed hourly and builds the 7- and 30-day ISK destroyed rankings.
  - `collect-insurgency.mjs` records pirate insurgencies hourly from CCP's Frontlines data.
  - `collect-structures.mjs` updates the list of public player structures daily from EVE Ref.
  - `build-map.mjs` prepares map, station, system size and 3D position data daily.
  - `save-samples.mjs` saves samples of outside data feeds, for checking their format.
  - `build-ice.mjs` checks CCP's static data for ice belts (not currently run; see the note at its top).
- `.github/workflows/update.yml` tells GitHub when to run those jobs and how to publish the site.

## Setting it up

1. **Create a GitHub account** at github.com if you don't have one.

2. **Create a new repository.** Click **+** (top right), then **New repository**. Name it `quiet-space`, set it to **Public**, and leave the options for adding files unticked. Click **Create repository**.

3. **Upload the files.** On the new repository's page, click the link to upload an existing file. Unzip the download, open the `quiet-space` folder, and drag everything inside it into the upload area: `index.html`, `README.md`, the `scripts` folder and the `.github` folder. Then click **Commit changes**.
   - The `.github` folder starts with a dot, which hides it on a Mac. In Finder, press **Cmd + Shift + .** to show hidden files.
   - After uploading, check that `.github/workflows/update.yml` appears in the repository. Without it, nothing runs.
   - GitHub will start a first run straight away. It may fail at the publishing step until you've done steps 4 and 5; that's expected.

4. **Turn on GitHub Pages.** Go to **Settings**, then **Pages**. Under **Build and deployment**, set **Source** to **GitHub Actions**.

5. **Allow the Action to save data.** Go to **Settings**, then **Actions**, then **General**. Under **Workflow permissions**, choose **Read and write permissions** and click **Save**.

6. **Run it.** Open the **Actions** tab, select **Update data and publish site**, click **Run workflow**, tick **Rebuild all map and station data from scratch**, and click the green **Run workflow** button. The first run takes roughly 10 to 30 minutes, since it downloads the whole map from ESI.

7. **Visit your site** at `https://YOUR-USERNAME.github.io/quiet-space/`. The address also appears under **Settings**, then **Pages**, once the first run has finished.

## What happens next

- **Every hour,** the Action records traffic and republishes the site with updated averages and weekly patterns.
- **Every day after EVE downtime,** it refreshes map, station and size data, and does a full refresh once a week.
- **System sizes fill in over about three days.** Sizes need every planet's position, roughly 40,000 lookups, so each run fetches up to 15,000 and continues the next day.
- **The 30-day average** starts working after the first few hours and becomes reliable after a few days.
- **Weekly patterns** need time to build. The pop-up says how many weeks of data it's based on, up to 12.

Collected data is kept on a separate branch called `data`. Each run replaces that branch completely, so it never grows: history older than 12 weeks is deleted, and no old versions build up.

## Changing the site

Edit `index.html` on GitHub (open it and click the pencil icon) or upload a new version. Committing to `main` republishes the site automatically within a few minutes.

## If something goes wrong

- **A run failed:** open it in the **Actions** tab and click the failed step to see what happened. ESI outages, especially around daily downtime at 11:00 UTC, can cause occasional failures. The next run usually recovers, and the site keeps its last good data.
- **The site shows a 404:** wait a few minutes after the first successful run, then reload.
- **Hourly runs stopped:** GitHub pauses scheduled runs in public repositories after 60 days with no activity in the repository. It emails you when that happens; re-enable the workflow from the **Actions** tab.
- **Data feed samples** for upcoming features (pirate insurgencies and player structures) are saved daily in the `samples` folder on the `data` branch. To view them, switch to the `data` branch using the branch menu on the repository's main page.

## Data sources

- Traffic, systems, stations, sovereignty and faction warfare: [EVE ESI](https://developers.eveonline.com/docs/services/esi/overview/), the official EVE Online API.
- Kills and their ISK values: [zKillboard](https://zkillboard.com/)'s R2Z2 live feed.
- Public player structures: [EVE Ref](https://docs.everef.net/datasets/structures).
- Pirate insurgencies: CCP's Frontlines data on eveonline.com.
- System sizes: CCP's static data export.
- Ice belt systems: the [EVE University wiki](https://wiki.eveuniversity.org/Ice_harvesting).

EVE Online and all related names are trademarks of CCP hf. This is a fan-made tool and isn't affiliated with or endorsed by CCP.
