/* --------------------------------------------------------------------------------------------
 * Copyright (c) Jan Dolejsi. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { QuickDiffProvider, Uri, CancellationToken, ProviderResult, WorkspaceFolder, workspace } from "vscode";
import * as path from 'path';
import { compareMaps } from "../utils";
import { SessionConfiguration, strMapToObj, SessionMode } from "./SessionConfiguration";
import { getText, postJson, getJson } from "../httpUtils";
import { checkResponseForError } from "../catalog/PlanningDomains";

/** Represents one Planning.Domains session and meta-data. */
export class SessionContent implements SessionConfiguration {
	constructor(public hash: string, public writeHash: string, public versionDate: number,
		public files: Map<string, string>) { }

	static from(configuration: SessionConfiguration): SessionContent {
		return new SessionContent(configuration.hash, configuration.writeHash, configuration.versionDate, configuration.files);
	}

	canCommit(): boolean {
		return this.writeHash !== null && this.writeHash !== undefined;
	}

	getHash() {
		return this.writeHash || this.hash;
	}
}

export function areIdentical(first: Map<string, string>, second: Map<string, string>): boolean {
	return compareMaps(first, second);
}

export const SESSION_SCHEME = 'planning.domains.session';

/** This binds the local and remote repository. */
export class SessionRepository implements QuickDiffProvider {

	constructor(private workspaceFolder: WorkspaceFolder, private session: SessionContent) { }

	provideOriginalResource?(uri: Uri, _: CancellationToken): ProviderResult<Uri> {
		// converts the local file uri to planning.domains.session:sessionId/file.ext
		let relativePath = workspace.asRelativePath(uri.fsPath);
		let fileName = path.basename(relativePath);
		return Uri.parse(`${SESSION_SCHEME}:${this.session.hash}/${fileName}`);
	}

	/**
	 * Enumerates the resources under source control.
	 */
	provideSourceControlledResources(): Uri[] {
		return [...this.session.files.keys()]
			.map(fileName => this.createLocalResourcePath(fileName))
			.map(filePath => Uri.file(filePath));
	}

	/**
	 * Creates a local file path in the local workspace that corresponds to the given file in the session.
	 *
	 * @param fileName session file name
	 * @returns path of the locally cloned session file
	 */
	createLocalResourcePath(fileName: string) {
		return path.join(this.workspaceFolder.uri.fsPath, fileName);
	}
}

const SESSION_URL = "http://editor.planning.domains/session/";
const SESSION_TABS_PATTERN = /"save-tabs"\s*:\s*{\s*"url"\s*:\s*"[\w:/.-]+"\s*,\s*"settings"\s*:\s*({[^}]*})/;
const SESSION_DETAILS_PATTERN = /window\.session_details\s*=\s*{\s*(?:readwrite_hash:\s*"(\w+)"\s*,\s*)?read_hash:\s*"(\w+)"\s*,\s*last_change:\s*"([\w: \(\)\+]+)",?\s*};/;

export async function checkSession(sessionId: string): Promise<[SessionMode, number]> {
	let url = `${SESSION_URL}check/${sessionId}`;

	let response = await getJson(url);

	checkResponseForError(response);

	var sessionMode: SessionMode;
	switch ((<string>response["type"]).toLowerCase()) {
		case "read":
			sessionMode = SessionMode.READ_ONLY;
			break;
		case "readwrite":
			sessionMode = SessionMode.READ_WRITE;
			break;
		default:
			throw new Error("Unexpected session type: " + response["type"]);
	}

	// last_change contains last session change time
	let sessionVersionDate: number = Date.parse(response["last_change"]);

	return [sessionMode, sessionVersionDate];
}

export async function getSession(sessionConfiguration: SessionConfiguration): Promise<SessionContent> {
	let rawSession = await getRawSession(sessionConfiguration);
	let savedTabsJson = JSON.parse(rawSession.domainFilesAsString);

	let fileNames = Object.keys(savedTabsJson);
	let sessionFiles = new Map<string, string>();
	fileNames.forEach(fileName => sessionFiles.set(fileName, savedTabsJson[fileName]));

	return new SessionContent(rawSession.readOnlyHash, rawSession.readWriteHash, rawSession.sessionDate, sessionFiles);
}

export async function uploadSession(session: SessionContent): Promise<SessionContent> {
	if (!session.writeHash) { throw new Error("Check if the session is writable first."); }

	let rawLatestSession = await getRawSession(session);

	// replace the session files
	let newFilesAsString = JSON.stringify(strMapToObj(session.files), null, 4);
	let newContent = rawLatestSession.sessionContent
		.replace(rawLatestSession.sessionDetails, '') // strip the window.session.details= assignment
		.replace(rawLatestSession.domainFilesAsString, newFilesAsString);

	var postBody = Object.create(null);
	postBody["content"] = newContent;
	postBody["read_hash"] = session.hash;
	postBody["readwrite_hash"] = session.writeHash;

	let url = `${SESSION_URL}${session.writeHash}`;

	let postResult = await postJson(url, postBody);

	if (postResult["error"]) {
		throw new Error(postResult["message"]);
	}

	// get the latest session
	return getSession(session);
}

export async function duplicateSession(session: SessionContent): Promise<string> {
	let rawLatestOrigSession = await getRawSession(session);

	// replace the session files
	let newFilesAsString = JSON.stringify(strMapToObj(session.files), null, 4);
	let newContent = rawLatestOrigSession.sessionContent
		.replace(rawLatestOrigSession.sessionDetails, '') // strip the window.session.details= assignment
		.replace(rawLatestOrigSession.domainFilesAsString, newFilesAsString);

	var postBody = Object.create(null);
	postBody["content"] = newContent;

	let postResult = await postJson(SESSION_URL, postBody);

	if (postResult["error"]) {
		throw new Error(postResult["message"]);
	}

	// get the latest session
	return postResult["result"]["readwrite_hash"];
}

async function getRawSession(sessionConfiguration: SessionConfiguration): Promise<RawSession> {
	let url = sessionConfiguration.writeHash ?
		`${SESSION_URL}edit/${sessionConfiguration.writeHash}` :
		`${SESSION_URL}${sessionConfiguration.hash}`;

	let sessionContent = await getText(url);

	var sessionDetails: string;
	var sessionDate: number;
	var readWriteHash: string;
	var readOnlyHash: string;

	SESSION_DETAILS_PATTERN.lastIndex = 0;
	let matchDetails = SESSION_DETAILS_PATTERN.exec(sessionContent);
	if (matchDetails) {
		sessionDetails = matchDetails[0];
		readWriteHash = matchDetails[1];
		readOnlyHash = matchDetails[2];
		sessionDate = Date.parse(matchDetails[3]);
	}
	else {
		throw new Error("Malformed saved session. Could not extract session date.");
	}

	var domainFilesString: string;

	SESSION_TABS_PATTERN.lastIndex = 0;
	let matchTabs = SESSION_TABS_PATTERN.exec(sessionContent);

	if (matchTabs) {
		domainFilesString = matchTabs[1];
	}
	else {
		throw new Error("Saved session contains no saved tabs.");
	}

	return {
		sessionDetails: sessionDetails,
		sessionContent: sessionContent,
		sessionDate: sessionDate,
		readOnlyHash: readOnlyHash,
		readWriteHash: readWriteHash,
		domainFilesAsString: domainFilesString
	};
}

interface RawSession {
	readonly sessionDetails: string;
	readonly sessionContent: string;
	readonly sessionDate: number;
	readonly readWriteHash: string;
	readonly readOnlyHash: string;
	readonly domainFilesAsString: string;
}