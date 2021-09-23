import * as core from "@actions/core";
import * as github from "@actions/github";
import { ApolloClient, HttpLink, InMemoryCache } from "@apollo/client/core";
import {
  GetCommits,
  GetCommitsQuery,
  GetCommitsQueryVariables,
  GetReleases,
  GetReleasesQuery,
  GetReleasesQueryVariables,
} from "./graphql/generated_types";
import fetch from "cross-fetch";
import _ from "lodash";
import axios from "axios";

export type ReleaseType = "development" | "rc" | "production";

export interface VersionInfo {
  major: number;
  minor: number;
  patch: number;
  releaseType: ReleaseType;
  releaseCandidate?: number;
  hash?: string;
}

function extractVersionInfo(versionString: string): VersionInfo | undefined {
  const regex =
    /^v(\d+).(\d+).(\d+)(-((development)|((rc).(\d+)))\+([a-f0-9]+))?$/gims;

  let m;

  const match = regex.exec(versionString);

  if (match) {
    if (match.index === regex.lastIndex) {
      regex.lastIndex++;
    }

    const major = parseInt(match[1]);
    const minor = parseInt(match[2]);
    const patch = parseInt(match[3]);
    const releaseType = (match[8] ?? match[5] ?? "production") as ReleaseType;
    const releaseCandidateNumber = parseInt(match[9]);
    const hash = match[10];

    return {
      major,
      minor,
      patch,
      releaseType,
      releaseCandidate: releaseCandidateNumber,
      hash,
    };
  }

  return undefined;
}

async function run() {
  const { GITHUB_REF, GITHUB_SHA } = process.env;

  if (!GITHUB_REF) {
    core.setFailed("Missing GITHUB_REF");
    return;
  }

  if (!GITHUB_SHA) {
    core.setFailed("Missing GITHUB_SHA");
    return;
  }

  const GITHUB_TOKEN = core.getInput("github_token");

  if (GITHUB_TOKEN === "") {
    core.setFailed("Missing GITHUB_TOKEN");
    return;
  }

  const octokit = github.getOctokit(GITHUB_TOKEN ?? "");

  const releaseType: ReleaseType = core.getInput("release_type") as ReleaseType;
  let targetBranch = "development";
  if (releaseType === "rc") {
    targetBranch = "qa";
  } else if (releaseType === "production") {
    targetBranch = "production";
  }

  const client = new ApolloClient({
    link: new HttpLink({
      uri: "https://api.github.com/graphql",
      fetch,
      headers: {
        Authorization: `bearer ${GITHUB_TOKEN}`,
      },
    }),
    cache: new InMemoryCache(),
  });

  const { data: releaseData, errors: releaseErrors } = await client.query<
    GetReleasesQuery,
    GetReleasesQueryVariables
  >({
    query: GetReleases,
    variables: {
      reponame: github.context.repo.repo,
    },
  });

  if (releaseErrors) {
    core.setFailed("Workflow failed! Error getting previous releases");
    return;
  }

  const releases = _.chain(releaseData.repository?.releases.edges)
    .map((release) => release?.node)
    .compact()
    .orderBy((release) => release.updatedAt, ["desc"])
    .value();

  const thisCommitData = await octokit.rest.git.getCommit({
    ...github.context.repo,
    commit_sha: github.context.sha,
  });
  const date = Date.parse(thisCommitData.data.author.date);

  // We use the last production release to ascertain the changelog
  const lastProductionRelease = _.chain(releases)
    .map((release) => ({
      versionInfo: extractVersionInfo(release.tag?.name ?? ""),
      releaseDate: release.updatedAt,
    }))
    .filter((r) => !!r.versionInfo && Date.parse(r.releaseDate) <= date)
    .find((release) => release.versionInfo?.releaseType === "production")
    .value();
  // We use the last dev release to ascertain the new version
  const lastDevRelease = _.chain(releases)
    .map((release) => ({
      versionInfo: extractVersionInfo(release.tag?.name ?? ""),
      releaseDate: release.updatedAt,
    }))
    .filter((r) => !!r.versionInfo && Date.parse(r.releaseDate) <= date)
    .find((release) => release.versionInfo?.releaseType === "development")
    .value();

  if (!lastProductionRelease.versionInfo) {
    lastProductionRelease.versionInfo = {
      major: 0,
      minor: 0,
      patch: 0,
      releaseType: "production",
    };
  }
  if (!lastDevRelease.versionInfo) {
    lastDevRelease.versionInfo = {
      major: 0,
      minor: 0,
      patch: 0,
      releaseType: "development",
    };
  }

  const { data: commitsDataDev, errors: commitsErrorDev } = await client.query<
    GetCommitsQuery,
    GetCommitsQueryVariables
  >({
    query: GetCommits,
    variables: {
      reponame: github.context.repo.repo,
      branchname: targetBranch,
      since: lastDevRelease.releaseDate,
      until: thisCommitData.data.author.date,
    },
  });
  const { data: commitsDataProd, errors: commitsErrorProd } =
    await client.query<GetCommitsQuery, GetCommitsQueryVariables>({
      query: GetCommits,
      variables: {
        reponame: github.context.repo.repo,
        branchname: targetBranch,
        since: lastProductionRelease.releaseDate,
        until: thisCommitData.data.author.date,
      },
    });

  if (commitsErrorProd || commitsErrorDev) {
    core.setFailed("Workflow failed. Error getting commit history");
    return;
  }

  const branchRefProd = commitsDataProd.repository?.refs?.edges?.[0];
  const branchRefDev = commitsDataDev.repository?.refs?.edges?.[0];
  if (!branchRefProd || !branchRefDev) {
    core.setFailed("Workflow failed. No branch ref");
    return;
  }

  const targetDev = branchRefDev?.node?.target;
  if (!targetDev || targetDev.__typename !== "Commit") {
    core.setFailed("Workflow failed. Ref target (dev) is not a commit");
    return;
  }
  const targetProd = branchRefProd?.node?.target;
  if (!targetProd || targetProd.__typename !== "Commit") {
    core.setFailed("Workflow failed. Ref target (prod) is not a commit");
    return;
  }

  const historyProd = _.chain(targetProd.history.edges)
    .map((edge) => edge?.node)
    .compact()
    .value();
  const historyDev = _.chain(targetDev.history.edges)
    .map((edge) => edge?.node)
    .compact()
    .value();

  let newVersion = `v${lastDevRelease.versionInfo.major}.${lastDevRelease.versionInfo.minor}.${lastDevRelease.versionInfo.patch}`;

  let metadata = "";
  if (releaseType === "development") {
    let hasPatch = false;
    let hasMinor = false;
    let hasMajor = false;
    _.map(historyDev, (commit) => {
      if (commit.message.toLowerCase().startsWith("fix")) {
        hasPatch = true;
      }
      if (commit.message.toLowerCase().startsWith("feat")) {
        hasMinor = true;
      }
      if (commit.message.toLowerCase().startsWith("breaking")) {
        hasMajor = true;
      }
    });

    const {
      major: oldMajor,
      minor: oldMinor,
      patch: oldPatch,
    } = lastDevRelease.versionInfo;
    let newMajor = oldMajor,
      newMinor = oldMinor,
      newPatch = oldPatch;

    if (hasMajor) {
      newMajor++;
      newMinor = 0;
      newPatch = 0;
    } else if (hasMinor) {
      newMinor++;
      newPatch = 0;
    } else if (hasPatch) {
      newPatch++;
    }

    newVersion = `v${newMajor}.${newMinor}.${newPatch}`;
    metadata = `-development+${github.context.sha.substring(0, 7)}`;
  } else if (releaseType === "rc") {
    const thisVersion = lastDevRelease.versionInfo;
    const numberRcsSinceProdRelease = _.chain(releases)
      .map((release) => ({
        versionInfo: extractVersionInfo(release.tag?.name ?? ""),
        releaseDate: Date.parse(release.updatedAt),
      }))
      .filter(
        (r) =>
          !!r.versionInfo &&
          r.releaseDate > Date.parse(lastProductionRelease.releaseDate) &&
          r.releaseDate <= date
      )
      .value();
    metadata = `-rc.${
      numberRcsSinceProdRelease.length
    }+${github.context.sha.substring(0, 7)}`;
  }

  const completeVersionString = `${newVersion}${metadata}`;

  const majorChanges = _.chain(historyProd)
    .filter((commit) => commit.message.toLowerCase().startsWith("breaking:"))
    .map((commit) => `- ${commit.message}`)
    .value();
  const minorChanges = _.chain(historyProd)
    .filter((commit) => commit.message.toLowerCase().startsWith("feat:"))
    .map((commit) => `- ${commit.message}`)
    .value();
  const patchChanges = _.chain(historyProd)
    .filter((commit) => commit.message.toLowerCase().startsWith("fix:"))
    .map((commit) => `- ${commit.message}`)
    .value();

  let changelog = "";
  if (majorChanges.length > 0) {
    changelog += `# Breaking Changes\n${_.join(majorChanges, "\n")}\n`;
  }
  if (minorChanges.length > 0) {
    changelog += `## New Features\n${_.join(minorChanges, "\n")}\n`;
  }
  if (patchChanges.length > 0) {
    changelog += `## Bug Fixes\n${_.join(patchChanges, "\n")}\n`;
  }

  // Create tag
  const newTag = await octokit.rest.git.createTag({
    ...github.context.repo,
    tag: completeVersionString,
    message: completeVersionString,
    object: GITHUB_SHA,
    type: "commit",
  });

  // Create ref
  await octokit.rest.git.createRef({
    ...github.context.repo,
    ref: `refs/tags/${completeVersionString}`,
    sha: newTag.data.sha,
  });

  // Create release
  const releaseResponse = await octokit.rest.repos.createRelease({
    ...github.context.repo,
    tag_name: completeVersionString,
    name: completeVersionString,
    body: changelog,
    draft: false,
    prerelease: releaseType !== "production",
  });

  console.log("Created release...", JSON.stringify(releaseResponse.data));

  const slackChannel = core.getInput("slack_channel");
  const slackToken = core.getInput("slack_token");

  await axios.post(
    "https://slack.com/api/chat.postMessage",
    {
      channel: slackChannel,
      text: `Release \`${completeVersionString}\` has been created on \`${github.context.repo.repo}\`\n<${releaseResponse.data.html_url}|View Changelog>`,
    },
    { headers: { authorization: `Bearer ${slackToken}` } }
  );
}

run().catch((error) => core.setFailed("Workflow failed! " + error.message));
