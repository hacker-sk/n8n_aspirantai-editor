# reel-bot (GitHub Actions)

Two daily jobs that make a video and post it to Instagram as a Reel. No server needed.

- **Daily news reel**: 09:00 IST. 10-second video from the top suitable post on your home page.
- **Daily job reel**: 18:00 IST. Scroll video of a job page with title card and music.

## Setup (about 30-40 minutes, once)

1. **Make a GitHub repo** (github.com > New repository, set it to **Private**). Upload everything in this folder, including the hidden `.github` folder (easiest: install GitHub Desktop, or use "Add file > Upload files" and drag the folder contents in).
2. **Add music**: put 2-3 royalty-free `.mp3` files in the `music` folder (commit them).
3. **Allow the bot to save history**: repo > Settings > Actions > General > Workflow permissions > select "Read and write permissions" > Save.
4. **Instagram access** (the hard part, see below) gives you two values. Add them at repo > Settings > Secrets and variables > Actions > **Secrets**:
   - `IG_ACCESS_TOKEN`
   - `IG_USER_ID`
5. **Add variables** (same page, **Variables** tab):
   - `JOB_LIST_URL` = page that lists jobs (default guess: https://www.aspirantai.co.in/discover)
   - `JOB_LINK_SELECTOR` = CSS selector that matches job links on that page (default guess: `a[href*="/jobs/"]`; send me one job page link and I will set the right one)
6. **Test without posting**: Actions tab > "Daily news reel" > Run workflow > keep "dry_run" ticked > Run. When it finishes, open the run, download the `video` from Artifacts, and check it. Do the same for "Daily job reel".
7. **First real post**: run the workflow again with "dry_run" unticked. If it works, the daily schedule runs by itself.

## Instagram access (Meta developer setup)
1. Instagram account must be **Business or Creator**, linked to a **Facebook Page**.
2. Go to developers.facebook.com > create an app (type: Business) > add the Instagram product. Add yourself as admin/tester.
3. In Graph API Explorer, get a user token with permissions: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`. Exchange it for a long-lived token, then read the Page token from `/me/accounts` (a Page token made from a long-lived user token does not expire).
4. Get the Instagram user id: `/{page-id}?fields=instagram_business_account`.
5. Put the Page token in `IG_ACCESS_TOKEN` and that id in `IG_USER_ID`.

By default the video is uploaded straight to Meta (resumable upload). Meta's docs say that method is for apps using Facebook Login for Business. If it errors, make the repo **Public**, add variable `IG_FALLBACK_URL` = `true`, and the bot will host the video temporarily on GitHub and post it by link instead.

## Notes
- Times are UTC in the workflow files. GitHub can start scheduled runs a few minutes late.
- Check the Actions tab now and then: GitHub can pause schedules in repos with no activity for 60 days.
- News posts are picked by keyword: political posts are skipped and repeats within 3 days are skipped. Change this in `src/news.js` (`NEWS_INCLUDE` / `NEWS_EXCLUDE`).
- Posted history is saved in the `state` folder by the bot itself.
