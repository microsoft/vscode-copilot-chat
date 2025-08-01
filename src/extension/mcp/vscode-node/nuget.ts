/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IValidatePackageArgs, ValidatePackageResult } from './commands';

interface NuGetServiceIndexResponse {
	resources?: Array<{ "@id": string; "@type": string }>;
}

interface NuGetSearchPackageItem {
	id: string;
	version: string;
	description?: string;
	owners?: Array<string>;
	packageTypes?: Array<{ "name": string }>;
}

interface NuGetSearchResponse {
	data?: Array<NuGetSearchPackageItem>;
}

export async function getNuGetPackageMetadata(args: IValidatePackageArgs): Promise<ValidatePackageResult> {
	// read the service index to find the search URL
	// https://learn.microsoft.com/en-us/nuget/api/service-index
	const serviceIndexUrl = `https://api.nuget.org/v3/index.json`;
	const serviceIndexResponse = await fetch(serviceIndexUrl);
	if (!serviceIndexResponse.ok) {
		return { state: 'error', error: `Unable to load the NuGet.org registry service index (${serviceIndexUrl})` };
	}

	// find the search query URL
	// https://learn.microsoft.com/en-us/nuget/api/search-query-service-resource
	const serviceIndex = await serviceIndexResponse.json() as NuGetServiceIndexResponse;
	const searchBaseUrl = serviceIndex.resources?.find(resource => resource['@type'] === 'SearchQueryService/3.5.0')?.['@id'];
	if (!searchBaseUrl) {
		return { state: 'error', error: `Package search URL not found in the NuGet.org registry service index` };
	}

	// search for the package by ID
	// https://learn.microsoft.com/en-us/nuget/consume-packages/finding-and-choosing-packages#search-syntax
	const searchQueryUrl = `${searchBaseUrl}?q=packageid:${encodeURIComponent(args.name)}&prerelease=true&semVerLevel=2.0.0`;
	const searchResponse = await fetch(searchQueryUrl);
	if (!searchResponse.ok) {
		return { state: 'error', error: `Failed to search for ${args.name} in the NuGet.org registry` };
	}
	const data = await searchResponse.json() as NuGetSearchResponse;
	if (!data.data?.[0]) {
		return { state: 'error', error: `Package ${args.name} not found on NuGet.org` };
	}

	const name = data.data[0].id ?? args.name;
	let version = data.data[0].version;
	if (version.indexOf('+') !== -1) {
		// NuGet versions can have a + sign for build metadata, we strip it for MCP config and API calls
		// e.g. 1.0.0+build123 -> 1.0.0
		version = version.split('+')[0];
	}

	const publisher = data.data[0].owners ? data.data[0].owners.join(', ') : 'unknown';

	// Try to fetch the package readme
	// https://learn.microsoft.com/en-us/nuget/api/readme-template-resource
	const readmeTemplate = serviceIndex.resources?.find(resource => resource['@type'] === 'ReadmeUriTemplate/6.13.0')?.['@id'];
	let readme = data.data[0].description || undefined;
	if (readmeTemplate) {
		const readmeUrl = readmeTemplate
			.replace('{lower_id}', encodeURIComponent(name.toLowerCase()))
			.replace('{lower_version}', encodeURIComponent(version.toLowerCase()));
		const readmeResponse = await fetch(readmeUrl);
		if (readmeResponse.ok) {
			readme = await readmeResponse.text();
		}
	}

	return {
		state: 'ok',
		publisher,
		name,
		version,
		readme
	};
}