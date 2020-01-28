const path = require("path"),
	https = require("https");

const PullRequestRegex = /(\d+)\/merge|pull\/(\d+)/i,
	MaxBranchNameLength = 20,
	BranchNamingConventionRegex = /^[A-Z]{2,10}-\d+-[A-Z][A-Za-z0-9-]+$/,
	BranchNamingConventionRegexHelp = "BranchNamingConventionRegex example: 'PW-10-Upgrade-mspec'. i.e. 2 - 10 uppercase alphabetic characters (matching Jira project key), then a hyphen, then some numbers (matching Jira reference), then requires another hyphen, an uppercase character, then some more characters (no spaces). Separate words with hyphens.",
	PullRequestTitleNamingConventionRegex = /^[A-Z]{2,10}-\d+ [A-Z].+$/,
	PullRequestTitleNamingConventionRegexHelp = "PullRequestTitleNamingConventionRegex example: 'PW-10 Upgrade mspec'. i.e. 2 - 10 uppercase alphabetic characters (matching Jira project key), then a hyphen, then some numbers (matching Jira reference), then requires space, an uppercase character, then some more characters.";

function setBuildNumber(usePackageJsonVersion, branch, gitHubToken, gitHubRepo, packageRelativePath, enforceNamingConvention) {

	console.log("Setting build number...");

	const tcProps = require("./tc-props")();

	branch = sanitiseBranchName(branch);

	const projectName = tcProps.get("teamcity.projectName"),
		fullHash = tcProps.get("build.vcs.number"),
		shortHash = fullHash.slice(0,7).toUpperCase();

	var buildNumber = tcProps.get("build.number");

	if(usePackageJsonVersion) {
		console.log("##teamcity[blockOpened name='package.json version']");

		console.log("Using package json version as build number");

		const packageJsonPath = getPackagePath(process.cwd(), packageRelativePath),
			packageJson = require(packageJsonPath),
			version = packageJson.version;

		console.log(`Current package json version is '${ version }'`);

		var buildCounter = tcProps.get("build.counter");
		console.log(`Build counter is '${ buildCounter }'`);

		// Use Major.Minor.Patch.Counter format
		buildNumber = `${ version }.${ buildCounter }`;

		console.log("##teamcity[blockClosed name='package.json version']");
	}

	console.log(`Setting build number for project '${ projectName }'`);
	console.log(`Current build number is '${ buildNumber }'`);
	console.log(`Branch is '${ branch }'`);

	if (branch == "master")
	{
		console.log("Building master");
		buildNumber = `${ buildNumber }+r${ shortHash }`;
		outputTeamCityBuildNumber(buildNumber);
		return buildNumber;
	}

	const pullRequestMatch = branch.match(PullRequestRegex);
	if(!pullRequestMatch) {
		console.log("Building a feature branch");
		branch = trimBranchName(branch);
		buildNumber = `${ buildNumber }-${ branch }`;
		outputTeamCityBuildNumber(buildNumber);
		return buildNumber;
	}

	console.log("##teamcity[blockOpened name='Pull Request']");
	var pullRequestId = pullRequestMatch[1] || (pullRequestMatch[2]);
	console.log(`Using pull request #${ pullRequestId }`);

	const githubMergeAttemptLimit = 12;
	let githubMergeAttemptCount = 0;

	getPullDetails();

	function getPullDetails() {
		getPullRequest(gitHubToken, gitHubRepo, pullRequestId)
			.then(data => {
				githubMergeAttemptCount++;
				if (data.mergeable === null) { // this case occurs if Github hasn't finished the merge assesment at the time of the request
					console.log(`Pull request #${pullRequestId} hasn't been assessed for merge into master yet. Attempt ${githubMergeAttemptCount} of ${githubMergeAttemptLimit}.`);
					if (githubMergeAttemptCount < githubMergeAttemptLimit) {
						setTimeout(getPullDetails, 5000);
					} else {
						console.error(
							`##teamcity[message text='#Couldn't assess mergeability of pull request ${pullRequestId} from Github.' status='ERROR']`
						);
						process.exit(1);
					}
				} else {
					processPullDetails(data);
				}
			})
			.catch(error => {
				console.error(
					`##teamcity[message text='Error getting pull request info: ${error.message}' errorDetails='${error.stack}' status='ERROR']`
				);
			});
	}

	function processPullDetails(data) {
		if (!data.mergeable) {
			console.error(
				`Pull request #${pullRequestId} is not mergeable into master.`
			);
			process.exit(1);
		} else if (
			!nameMatchesConvention(
				enforceNamingConvention,
				BranchNamingConventionRegex,
				data.head.ref
			)
		) {
			console.error(
				`Branch name '${data.head.ref}' does not match naming convention regex: '${BranchNamingConventionRegex}' ${BranchNamingConventionRegexHelp}`
			);
			process.exit(1);
		} else if (
			!nameMatchesConvention(
				enforceNamingConvention,
				PullRequestTitleNamingConventionRegex,
				data.title
			)
		) {
			console.error(
				`Pull request title '${data.title}' does not match naming convention regex: '${PullRequestTitleNamingConventionRegex}' ${PullRequestTitleNamingConventionRegexHelp}`
			);
			process.exit(1);
		} else {
			console.log(`Pull request #${pullRequestId} can be merged into master.`);
			branch = trimBranchName(sanitiseBranchName(data.head.ref));
			console.log(`Branch for PR #${pullRequestId} is '${branch}'.`);
			buildNumber = `${buildNumber}-${branch}`;
			outputTeamCityBuildNumber(buildNumber);
			console.log("##teamcity[blockClosed name='Pull Request']");
		}
	}
}

/**
 * Gets a pull request object from the GitHub API, returning a promise.
 *
 * @param      {string}   gitHubToken    The GitHub authentication token
 * @param      {string}   gitHubRepo     The string repo e.g. "nhsevidence/NICE.TopHat"
 * @param      {integer}   pullRequestId  The pull request identifier
 * @return     {Promise}  A promise that resolves with the PR object.
 */
function getPullRequest(gitHubToken, gitHubRepo, pullRequestId) {
	const auth = `${gitHubToken}:x-oauth-basic`,
		authToken = Buffer.from(auth).toString("base64"),
		requestOptions = {
			method: "GET",
			protocol: "https:",
			port: 443,
			hostname: "api.github.com",
			path: `/repos/${gitHubRepo}/pulls/${pullRequestId}`,
			headers: {
				Authorization: `Basic ${authToken}`,
				"User-Agent": "TeamCity"
			}
		};

	return new Promise((resolve, reject) => {
		const request = https.request(requestOptions, function(response) {
			const body = [];
			response.on("data", d => {
				body.push(d);
			});
			response.on("end", () => {
				if (response.statusCode < 200 || response.statusCode > 299) {
					reject(
						new Error(
							`Failed to load page, status code: ${response.statusCode}`
						)
					);
				} else {
					try {
						const parsed = JSON.parse(body.join(""));
						resolve(parsed);
					} catch (error) {
						reject(error);
					}
				}
			});
		});

		request.on("error", reject);
		request.end();
	});
}

/**
 * Writes the teamcity build number to the log
 *
 * @param      {string}  buildNumber  The build number
 */
function outputTeamCityBuildNumber(buildNumber) {
	console.log(`##teamcity[buildNumber '${buildNumber}']`);
}

/**
 * Sanitises a branch name by removing things like refs/heads to get the
 * raw branch name
 *
 * @param      {string}  branchName  The branch name
 * @return     {string}  { The sanitised branch name }
 */
function sanitiseBranchName(branchName) {
	// Sometimes branches are like "refs/heads/master" or "refs/pulls/15/merge"
	branchName = branchName.replace("refs/heads/", "");
	branchName = branchName.replace("refs/pulls/", "");
	branchName = branchName.replace("feature/", "");
	return branchName;
}

/**
 * Trims a branch name if it's too long
 *
 * @param      {string}  branchName  The branch name
 * @return     {string}  { The new, trimmed branch name }
 */
function trimBranchName(branchName) {
	if (branchName.length > MaxBranchNameLength) {
		console.log(
			`Branch '${branchName}'' name too long, trimming to ${MaxBranchNameLength} chars.`
		);
		branchName = branchName.substring(0, MaxBranchNameLength);
		console.log(`Trimmed to '${branchName}'.`);
	}

	return branchName;
}

/**
 * Joins up the process current working directory with a relative path for the package.json file
 *
 * @param      {string}  processCwd  Process current working directory
 * @param      {string}  packageRelativePath  relative path to the package.json file within the solutions directory
 * @return     {string}  { The correct path to the package.json file. }
 */
function getPackagePath(processCwd, packageRelativePath) {
	if (
		typeof packageRelativePath == "undefined" ||
		packageRelativePath === null
	) {
		packageRelativePath = "";
	}
	return path.join(processCwd, packageRelativePath, "package.json");
}

/**
 * Returns true or false about whether a string matches the naming convention.
 *
 * @param      {boolean}  enforceNamingConvention  Whether to enforce this naming convention
 * @param      {string}  namingConventionRegEx  The regular expression to apply to the nameToTest, if the enforceNamingConvention parameter is true.
 * @param      {string}  nameToTest  This will be either a branch name or a pull request name.
 * @return     {boolean}  { true if the enforce naming convention isn't set, is set to false, or if the nameToTest matches the convention }
 */
function nameMatchesConvention(
	enforceNamingConvention,
	namingConventionRegEx,
	nameToTest
) {
	if (
		enforceNamingConvention === false ||
		typeof enforceNamingConvention === "undefined" ||
		enforceNamingConvention === null ||
		typeof namingConventionRegEx === "undefined" ||
		namingConventionRegEx === null
	) {
		return true;
	}
	return namingConventionRegEx.test(nameToTest);
}

module.exports = {
	setBuildNumber: setBuildNumber,
	getPullRequest: getPullRequest,
	outputTeamCityBuildNumber: outputTeamCityBuildNumber,
	sanitiseBranchName: sanitiseBranchName,
	trimBranchName: trimBranchName,
	MaxBranchNameLength: MaxBranchNameLength,
	getPackagePath: getPackagePath,
	nameMatchesConvention: nameMatchesConvention,
	BranchNamingConventionRegex: BranchNamingConventionRegex,
	PullRequestTitleNamingConventionRegex: PullRequestTitleNamingConventionRegex,
	PullRequestRegex: PullRequestRegex
};
