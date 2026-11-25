# Lake

**The platform for teams running many AI coding agents.**

Lake is one product, for heads of engineering and the leads who run the team. **Gate** is plan approval: plans live in the PR, a teammate or a manager reviews in rounds, and the PR can't merge until that exact plan version is approved. **Meter** is cost control: a model and an estimated cost for every step, a run cap that stops and asks, and budget-owner approval above a limit you set. They are capabilities of Lake, not separate products.

Merge blocking is how Gate enforces approval, not the point: the PR can't merge until the current version of the plan is approved.

Website: **[getlake.dev](https://getlake.dev/)** · Pricing: **[getlake.dev/#pricing](https://getlake.dev/#pricing)** · Live demo: **[review app with a sample team](https://getlake.dev/lake-gate/app/#/demo)**

This is Lake's public home for docs, releases and support. The source code isn't published here.

## How it works

1. **The agent writes a plan.** When Claude Code leaves plan mode, the plan is saved to `.lake/plans/` in your repo as a versioned file. Cursor and other agents use the CLI.
2. **Lake puts an estimated cost on every step.** A complexity rating, a recommended model and a $ range per step, so the review covers what the plan will cost too. Reviewers can swap in a cheaper model, drop a step or set a cap in one click.
3. **A teammate reviews it.** In the Lake review app, with GitHub's own Approve button, or from your agent chat (MCP). Edit one word of the plan and the approval no longer applies.
4. **The agent builds, within a cap.** Edits wait for the approval, and a PR check keeps unapproved plans from merging. During the run, a per-run cost cap stops and asks before spending more.

Lake runs in your repo and on GitHub. Plans stay in your repo. The CLI, hooks, license check and Action make no network calls home and send no telemetry. The hosted review app counts anonymous, cookieless pageviews (GoatCounter).

## Install

```bash
cd your-repo
npm i -D lake-gate
npx lake-gate init --cap 5       # plan review + a $5 per-run cost cap
git add .gitignore .lake .claude/settings.json .github .mcp.json .cursor/mcp.json && git commit -m "Add Lake" && git push
npx lake-gate ui                 # the review app on localhost
```

Working alone? `npm i -D lake-gate && npx lake-gate init --try --cap 10` sets up solo mode, where you approve your own plans locally. Bringing in your team later: `npx lake-gate init --team`.

The current release is 0.3.2 on npm (`npx lake-gate --version`). Your 14-day trial starts on the first `init`.

`init` keeps the cost cap's per-machine files (`.claude/settings.local.json`, its backup and `.claude/skills/meter/`) out of git with `.gitignore`: they point at paths on your machine. Each teammate runs `npx lake-gate init --cap <usd>` for their own cap.

**Blocking merges.** Require the `lake/plan-approval` status in branch protection (Settings → Branches → Require status checks). Don't require the workflow job (`Lake plan gate / runner …`, or `plan-gate` in older workflows): it only runs the check and passes even while a plan waits. Required checks need a public repo, or GitHub Pro/Team for private repos. Without them the check is advisory: it shows red, but GitHub still lets the PR merge.

**PRs opened by an agent or bot** with the workflow's `GITHUB_TOKEN` don't start other workflows, so `lake/plan-approval` appears only after a human acts on the PR: a `/lake` comment, a review, or one pushed commit. Or open agent PRs with a personal or GitHub App token.

Requirements: Node 18.17+, git, a GitHub repo. Full docs: the package README on [npm](https://www.npmjs.com/package/lake-gate).

## Action usage

The PR check is a GitHub Action in this repo: `getlake/lake@v0`. `npx lake-gate init` writes the workflow for you; to add it by hand, save this as `.github/workflows/lake-gate.yml`:

```yaml
name: Lake plan gate
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  pull_request_review:
    types: [submitted, edited, dismissed]
  issue_comment:
    types: [created, edited, deleted]
  push:
    paths: ['.lake/config.json']
permissions:
  contents: read
  pull-requests: write
  issues: write
  statuses: write
jobs:
  plan-gate:
    name: runner (require lake/plan-approval, not this)
    if: github.event_name != 'issue_comment' || (github.event.issue.pull_request && contains(github.event.comment.body, '/lake'))
    runs-on: ubuntu-latest
    steps:
      - uses: getlake/lake@v0
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
```

It sets the `lake/plan-approval` status: success once every plan in `.lake/plans/` that the PR touches is approved, for its current version, by someone other than the PR author (`/lake approve <id>@<version>` or GitHub's Approve). Make that status (not the workflow job) required in branch protection to block merges; that needs a public repo, or GitHub Pro/Team for a private one. The Action only reads the PR and its approvals with the workflow's token; it needs no license key and makes no other network calls. `v0` tracks the latest 0.x release; pin `v0.3.2` for a fixed version.

## Pricing

| Plan | Price | Includes |
|---|---|---|
| **Solo** | $12/month | Plan review for your own runs, a model and an estimated cost for every step, the run cap, review app and MCP |
| **Team** | $15 per user/month | Everything in Solo, teammate approval of the exact plan version, the PR merge check, budget approval above a limit |

Both start with a **14-day free trial**, available now: install and run `init`, no card needed. Paid checkout opens soon; until then nothing is charged.

- **Founding offer:** the first 50 users get 2 months free, then 50% off for life.
- **Design partners:** 5 teams get 3 months free, then 50% off for life, in exchange for a feedback call and real use.

Claim either in [this discussion](https://github.com/getlake/getlake.github.io/discussions/1) (public, so share only what you're happy to have public).

## Trial and license key

- The 14-day trial starts the first time you run `init` (or save a plan) on a machine. `npx lake-gate license` shows the days left.
- With a key: `npx lake-gate license activate <key>`, or set `LAKE_LICENSE_KEY` in CI. The key is checked offline. Lake makes no network call for licensing.
- When the trial or key ends, new work pauses with a note on how to get a key. Existing plans, approvals, the review app and the PR check keep working, the local gate stops blocking (it never locks your repo), and `uninstall` always works.

## Meter

Meter is Lake's cost-control capability: the per-step model picks, cost estimates and run cap are built into Lake. A standalone package remains available for existing Meter-only installs; new installs should use Lake.

## Support

Questions and bugs: [open an issue](https://github.com/getlake/lake/issues) in this repo.

## License

Lake is proprietary software, © 2026 Lake. See [LICENSE](LICENSE). Earlier releases published under the MIT License (lake-gate up to 0.2.5, lake-meter up to 0.1.4) stay under the MIT License.
