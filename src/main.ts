import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  ApolloClient,
  HttpLink,
  InMemoryCache,
  NormalizedCacheObject,
} from "@apollo/client/core";
import {
  Commit,
  GetCommits,
  GetCommitsQuery,
  GetCommitsQueryVariables,
  GetReleases,
  GetReleasesQuery,
  GetReleasesQueryVariables, Release, ReleaseEdge,
} from "./graphql/generated_types";
import fetch from "cross-fetch";
import _ from "lodash";
import axios from "axios";
import dotenv from "dotenv";
import FormData from "form-data";
import { WebClient, LogLevel } from "@slack/web-api";

dotenv.config();

export type ReleaseType = "development" | "rc" | "production";
export type HistoryList =
  | ({ __typename?: "Commit" | undefined } & Pick<
      Commit,
      "id" | "oid" | "message" | "abbreviatedOid"
    >)[]
  | undefined;

export interface VersionInfo {
  major: number;
  minor: number;
  patch: number;
  releaseType: ReleaseType;
  releaseCandidate?: number;
  hash?: string;
}

export interface UsefulReleaseData {
  name: string;
  versionInfo: VersionInfo;
  releaseDate: string;
  tagDate: string;
  sha: string;
  isDraft: boolean;
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

async function getReleases(client: ApolloClient<NormalizedCacheObject>): Promise<UsefulReleaseData[]> {
  const reponame = process.env.GITHUB_REPO ?? github.context.repo.repo;

  const allEdges: ReleaseEdge[] = [];
  let hasNextPage = true;
  let currentCursor: string | undefined = undefined;

  do {
    core.info(`Fetching releases from ${currentCursor ?? "start"}`);
    // @ts-ignore
    const {data, errors} = await client.query<GetReleasesQuery,
        GetReleasesQueryVariables>({
      query: GetReleases,
      variables: {
        reponame,
        after: currentCursor
      },
    });

    if (errors) {
      core.setFailed("Workflow failed! Error getting previous releases");
      return [];
    }

    data.repository?.releases.edges?.map((edge: ReleaseEdge) => {
        if (edge) {
          allEdges.push(edge);
        }
    });

    currentCursor = data.repository?.releases.pageInfo.endCursor;
    hasNextPage = data.repository?.releases.pageInfo.hasNextPage ?? false;
  } while (hasNextPage);

  const returnableData: UsefulReleaseData[] = [];

    allEdges.map((edge: ReleaseEdge) => {
      if(edge.node) {
        const versionInfo = extractVersionInfo(edge.node.name ?? "");
        if (versionInfo) {
          returnableData.push({
            name: edge.node.name ?? "",
            versionInfo,
            releaseDate: edge.node.updatedAt,
            tagDate: edge.node.tagCommit?.authoredDate ?? "",
            sha: edge.node.tagCommit?.oid ?? "",
            isDraft: edge.node.isDraft,
          });
        }
      }
    });

    return returnableData;
}

function generateChangelog(historyMessages: string[]) {
  const majorChanges = _.chain(historyMessages)
    .filter((message) => message.trim().toLowerCase().startsWith("breaking:"))
    .map((message) => `- ${message}`)
    .value();
  const minorChanges = _.chain(historyMessages)
    .filter((message) => message.trim().toLowerCase().startsWith("feat:"))
    .map((message) => `- ${message}`)
    .value();
  const patchChanges = _.chain(historyMessages)
    .filter((message) => message.trim().toLowerCase().startsWith("fix:"))
    .map((message) => `- ${message}`)
    .value();
  const patchChoreChanges = _.chain(historyMessages)
    .filter((message) => message.trim().toLowerCase().startsWith("chore:"))
    .map((message) => `- ${message}`)
    .value();
  const patchRefactorChanges = _.chain(historyMessages)
    .filter((message) => message.trim().toLowerCase().startsWith("refactor:"))
    .map((message) => `- ${message}`)
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
  if (patchChoreChanges.length > 0) {
    changelog += `## Chores\n${_.join(patchChoreChanges, "\n")}\n`;
  }
  if (patchRefactorChanges.length > 0) {
    changelog += `## Refactors\n${_.join(patchRefactorChanges, "\n")}\n`;
  }
  return changelog;
}

async function run() {
  await dotenv.config();
  const GITHUB_REF = process.env.GITHUB_REF;
  const GITHUB_SHA = process.env.GITHUB_SHA;

  if (!GITHUB_REF) {
    core.setFailed("Missing GITHUB_REF");
    return;
  }

  if (!GITHUB_SHA) {
    core.setFailed("Missing GITHUB_SHA");
    return;
  }

  const GITHUB_TOKEN =
    process.env.GITHUB_TOKEN ?? core.getInput("github_token");

  if (GITHUB_TOKEN === "") {
    core.setFailed("Missing GITHUB_TOKEN");
    return;
  }

  const octokit = github.getOctokit(GITHUB_TOKEN ?? "");

  const releaseTypeInput =
    process.env.RELEASE_TYPE ?? core.getInput("release_type") ?? "development";
  const releaseType: ReleaseType = releaseTypeInput as ReleaseType;
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

  const releases = await getReleases(client);
  const repoOwner = process.env.GITHUB_OWNER ?? github.context.repo.owner ?? "";
  const repoName = process.env.GITHUB_REPO ?? github.context.repo.repo ?? "";

  const thisCommitData = await octokit.rest.git.getCommit({
    owner: repoOwner,
    repo: repoName,
    commit_sha: GITHUB_SHA,
  });
  const date = Date.parse(thisCommitData.data.author.date);


  core.info(`Found ${releases.length} releases`);

  const isDryRun = process.env.DRY_RUN;

  if(isDryRun) {
    releases.map((release) => {
      core.info(`Release: ${release.name}, isDraft: ${release.isDraft}, type: ${release.versionInfo.releaseType}, date: ${release.releaseDate}`);
    })
    core.info("--------------------");
  }

  // We use the last production release to ascertain the changelog
  let lastProductionRelease = _.find(releases, (r) => Date.parse(r.releaseDate) <= date && r.versionInfo.releaseType === "production" && !r.isDraft);

  // We use the last dev release to ascertain the new version
  let lastDevRelease = _.find(releases, (r) => Date.parse(r.tagDate) <= date && r.versionInfo.releaseType === "development" && !r.isDraft);

  if (!lastProductionRelease || !lastProductionRelease.versionInfo) {
    lastProductionRelease = {
      name: "",
      versionInfo: {
        major: 0,
        minor: 0,
        patch: 0,
        releaseType: "production",
      },
      releaseDate: "",
      tagDate: "",
      sha: "",
      isDraft: false,
    };
  }
  if (!lastDevRelease || !lastDevRelease.versionInfo) {
    lastDevRelease = {
      name: "",
      versionInfo: {
        major: 0,
        minor: 0,
        patch: 0,
        releaseType: "development",
      },
      releaseDate: "",
      tagDate: "",
      sha: "",
      isDraft: false,
    };
  }

   core.info(`lastProductionRelease: ${lastProductionRelease.name}`);
   core.info(`lastDevRelease: ${lastDevRelease.name}`);
  
  const comparedDevCommits = await octokit.rest.repos.compareCommits({
    repo: repoName,
    owner: repoOwner,
    base: lastDevRelease.sha,
    head: GITHUB_SHA,
  });
  const comparedProdCommits = await octokit.rest.repos.compareCommits({
    repo: repoName,
    owner: repoOwner,
    base: lastProductionRelease.sha,
    head: GITHUB_SHA,
  });
  const historyDev = comparedDevCommits.data.commits;
  const historyProd = comparedProdCommits.data.commits;
  let newVersion = `v${lastDevRelease.versionInfo?.major}.${lastDevRelease.versionInfo?.minor}.${lastDevRelease.versionInfo?.patch}`;

  let metadata = "";
  if (releaseType === "development") {
    let hasPatch = false;
    let hasMinor = false;
    let hasMajor = false;
    _.map(historyDev, (commit) => {
      if (
        commit.commit.message.trim().toLowerCase().startsWith("fix") ||
        commit.commit.message.trim().toLowerCase().startsWith("chore") ||
        commit.commit.message.trim().toLowerCase().startsWith("refactor")
      ) {
        hasPatch = true;
      }
      if (commit.commit.message.trim().toLowerCase().startsWith("feat")) {
        hasMinor = true;
      }
      if (commit.commit.message.trim().toLowerCase().startsWith("breaking")) {
        hasMajor = true;
      }
    });

    core.info(`Major: ${hasMajor}, Minor: ${hasMinor}, Patch: ${hasPatch}`);

    const {
      major: oldMajor,
      minor: oldMinor,
      patch: oldPatch,
    } = lastDevRelease.versionInfo ?? { major: 0, minor: 0, patch: 0 };
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
    metadata = `-development+${GITHUB_SHA.substring(0, 7)}`;
  } else if (releaseType === "rc") {
    const numberRcsSinceProdRelease = _.chain(releases)
      .map((release) => ({
        versionInfo: extractVersionInfo(release.name ?? ""),
        releaseDate: Date.parse(release.releaseDate),
      }))
      .filter(
        (r) =>
          !!r.versionInfo &&
          r.versionInfo.releaseType === "rc" &&
          r.releaseDate > Date.parse(lastProductionRelease?.releaseDate ?? "") &&
          r.releaseDate <= date + 1
      )
      .value();
    metadata = `-rc.${
      numberRcsSinceProdRelease.length + 1
    }+${github.context.sha.substring(0, 7)}`;
  }

  core.info(`newVersion ${newVersion}`);
  core.info(`metadata ${metadata}`);
  const completeVersionString = `${newVersion}${metadata}`;
  core.info(`completeVersionString ${completeVersionString}`);
  
  const changelog = generateChangelog(
    _.map(historyProd, (commit) => commit.commit.message)
  );

  core.setOutput("version", completeVersionString);
  console.log("::set-output name=version::" + completeVersionString);
  console.log(
    "::set-output name=versionNumber::" + newVersion.replace("v", "")
  );

  if (isDryRun) {
    console.log("DRY RUN");
    console.log(`New version string: ${completeVersionString}`);
    console.log(`Changelog:\n${changelog}`);
  } else {
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
      body: changelog,
      draft: false,
      prerelease: releaseType !== "production",
    });

    const slackChannel = core.getInput("slack_channel");
    const slackToken = core.getInput("slack_token");

    const slackClient = new WebClient(slackToken, {
      // LogLevel can be imported and used to make debugging simpler
      logLevel: LogLevel.DEBUG,
    });
    await slackClient.files.upload({
      channels: slackChannel,
      content: changelog,
      title: "Changelog",
      initial_comment: `${_.startCase(
        repoName
      )} release \`${completeVersionString}\` created on \`${targetBranch}\`. Deploying... :warning:`,
    });
  }
}

run().catch((error) => core.setFailed("Workflow failed! " + error.message));
