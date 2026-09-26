"use strict";

const SOF_INDEX_REPO = "sovvie/sof-index";
const SOF_INDEX_BRANCH = "main";

const WALLY_INDEX_REPO = "UpliftGames/wally-index";
const WALLY_INDEX_BRANCH = "main";
const WALLY_API_URL = "https://api.wally.run";

const SOF_RELEASE_ASSET_NAME = "package.tar.gz";

// Where sof itself is released (install scripts and sof run self update).
const SOF_CLI_REPO = process.env.SOF_CLI_REPO || "sovvie/sof";

module.exports = {
  SOF_INDEX_REPO,
  SOF_INDEX_BRANCH,
  SOF_RELEASE_ASSET_NAME,
  SOF_CLI_REPO,
  WALLY_INDEX_REPO,
  WALLY_INDEX_BRANCH,
  WALLY_API_URL,
};
