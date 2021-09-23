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

  const lastProductionRelease = _.chain(releases)
    .map((release) => ({
      versionInfo: extractVersionInfo(release.tag?.name ?? ""),
      releaseDate: release.updatedAt,
    }))
    .filter((r) => !!r.versionInfo)
    .find((release) => release.versionInfo?.releaseType === "production")
    .value();

  if (!lastProductionRelease.versionInfo) {
    lastProductionRelease.versionInfo = {
      major: 0,
      minor: 0,
      patch: 0,
      releaseType: "production",
    };
  }

  const { data: commitsData, errors: commitsError } = await client.query<
    GetCommitsQuery,
    GetCommitsQueryVariables
  >({
    query: GetCommits,
    variables: {
      reponame: github.context.repo.repo,
      branchname: targetBranch,
      since: lastProductionRelease.releaseDate,
    },
  });

  if (commitsError) {
    core.setFailed("Workflow failed. Error getting commit history");
    return;
  }

  const branchRef = commitsData.repository?.refs?.edges?.[0];
  if (!branchRef) {
    core.setFailed("Workflow failed. No branch ref");
    return;
  }

  const target = branchRef?.node?.target;
  if (!target || target.__typename !== "Commit") {
    core.setFailed("Workflow failed. Ref target is not a commit");
    return;
  }

  const history = _.chain(target.history.edges)
    .map((edge) => edge?.node)
    .compact()
    .value();

  let hasPatch = false;
  let hasMinor = false;
  let hasMajor = false;
  _.map(history, (commit) => {
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
  } = lastProductionRelease.versionInfo;
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

  const newVersion = `v${newMajor}.${newMinor}.${newPatch}`;

  let metadata = "";
  if (releaseType === "development") {
    metadata = `-development+${history[0].abbreviatedOid}`;
  } else if (releaseType === "rc") {
    const lastRcForThisVersion = _.chain(releases)
      .map((release) => ({
        versionInfo: extractVersionInfo(release.tag?.name ?? ""),
        releaseDate: release.updatedAt,
      }))
      .filter((r) => !!r.versionInfo)
      .find(
        (release) =>
          release.versionInfo?.releaseType === "rc" &&
          release.versionInfo.major === newMajor &&
          release.versionInfo.minor === newMinor &&
          release.versionInfo.patch === newPatch
      )
      .value();
    metadata = `-rc.${lastRcForThisVersion.versionInfo?.releaseCandidate ?? 0}`;
  }

  const completeVersionString = `${newVersion}${metadata}`;

  const octokit = github.getOctokit(GITHUB_TOKEN ?? "");

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
  await octokit.rest.repos.createRelease({
    ...github.context.repo,
    tag_name: completeVersionString,
    name: completeVersionString,
    body: "Example body",
    draft: false,
    prerelease: releaseType !== "production",
  });
}

run().catch((error) => core.setFailed("Workflow failed! " + error.message));
