"use strict";

// The sof package registry (a Wally-style server). Override with SOF_REGISTRY_URL.
const SOF_REGISTRY_URL = (process.env.SOF_REGISTRY_URL || "https://sov.gg/sof-index").replace(/\/+$/, "");

const WALLY_INDEX_REPO = "UpliftGames/wally-index";
const WALLY_INDEX_BRANCH = "main";
const WALLY_API_URL = "https://api.wally.run";

// api.wally.run answers 426 to package downloads that carry no Wally-Version header
// (anything >= 0.3.0 is accepted).
const WALLY_CLIENT_VERSION = process.env.SOF_WALLY_CLIENT_VERSION || "0.3.2";

const SOF_RELEASE_ASSET_NAME = "package.tar.gz";

// Where sof itself is released (install scripts and sof run self update).
const SOF_CLI_REPO = process.env.SOF_CLI_REPO || "sovvie/sof";

module.exports = {
  SOF_REGISTRY_URL,
  SOF_RELEASE_ASSET_NAME,
  SOF_CLI_REPO,
  WALLY_INDEX_REPO,
  WALLY_INDEX_BRANCH,
  WALLY_API_URL,
  WALLY_CLIENT_VERSION,
};
