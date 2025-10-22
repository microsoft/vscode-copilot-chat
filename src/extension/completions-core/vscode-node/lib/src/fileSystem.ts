/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * `FileType` identifies the type of a file. `SymbolicLink` may be combined
 * with other types, e.g. `FileType.Directory | FileType.SymbolicLink`.
 */
export enum FileType {
	/** The file type is not known. */
	Unknown = 0,
	/** The file is a regular file. */
	File = 1,
	/** The file is a directory. */
	Directory = 2,
	/** The file is a symbolic link. */
	SymbolicLink = 64,
}

/**
 * The `FileStat`-type represents metadata about a file
 */
export interface FileStat {
	/**
	 * The creation timestamp in milliseconds elapsed since January 1, 1970 00:00:00 UTC.
	 */
	ctime: number;

	/**
	 * The modification timestamp in milliseconds elapsed since January 1, 1970 00:00:00 UTC.
	 *
	 * *Note:* If the file changed, it is important to provide an updated `mtime` that advanced
	 * from the previous value. Otherwise there may be optimizations in place that will not show
	 * the updated file contents in an editor for example.
	 */

	mtime: number;
	/**
	 * The size in bytes.
	 *
	 * *Note:* If the file changed, it is important to provide an updated `size`. Otherwise there
	 * may be optimizations in place that will not show the updated file contents in an editor for
	 * example.
	 */
	size: number;
	/**
	 * The type of file.
	 *
	 * *Note:* This is a bit field. Multiple flags may be set on it, e.g.
	 * `FileType.File | FileType.SymbolicLink`.
	 */
	type: FileType;
}

export type FileIdentifier = string | { readonly uri: string };

/**
 * A basic file-system interface for reading files and checking their mtime.
 */
export abstract class FileSystem {
	/**
	 * Read the entire contents of the given file.
	 *
	 * cf https://nodejs.org/api/fs.html#fs_fspromises_readfile_path_options
	 */
	abstract readFileString(uri: FileIdentifier): Promise<string>;

	/**
	 * Returns the meta data for the resource. In the case of a symbolic link,
	 * the stats are the state of the target, but type will include `FileType.SymbolicLink`.
	 */
	abstract stat(uri: FileIdentifier): Promise<FileStat>;

	/**
	 * Read the contents of a directory.
	 * @param uri The URI of the directory to read
	 * @returns A promise that resolves to an array of [name, type] pairs
	 */
	abstract readDirectory(uri: FileIdentifier): Promise<[string, FileType][]>;
}
