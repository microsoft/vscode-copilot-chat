/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Button, ToggleButton, Tooltip } from '@fluentui/react-components';
import { WeatherMoon20Regular, WeatherSunny20Regular } from '@fluentui/react-icons';
import * as mobx from 'mobx';
import * as mobxlite from 'mobx-react-lite';
import * as React from 'react';
import { InitArgs } from '../initArgs';
import { AMLProvider } from '../stores/amlSimulations';
import { RunnerOptions } from '../stores/runnerOptions';
import { SimulationRunsProvider } from '../stores/simulationBaseline';
import { SimulationRunner } from '../stores/simulationRunner';
import { SimulationTestsProvider } from '../stores/simulationTestsProvider';
import { TestSource, TestSourceValue } from '../stores/testSource';
import { AMLModeToolbar } from './amlModeToolbar';
import { ThemeKind } from './app';
import { LocalModeToolbar } from './localModeToolbar';
import { TestFilterer } from './testFilterer';

type ToolbarProps = {
	initArgs: InitArgs | undefined;
	runner: SimulationRunner;
	runnerOptions: RunnerOptions;
	amlProvider: AMLProvider;
	simulationRunsProvider: SimulationRunsProvider;
	simulationTestsProvider: SimulationTestsProvider;
	testSource: TestSourceValue;
	onFiltererChange: (filter: TestFilterer | undefined) => void;
	allLanguageIds: readonly string[];
	theme: ThemeKind;
	toggleTheme: () => void;
};

export const Toolbar = mobxlite.observer(
	({
		initArgs,
		runner,
		runnerOptions,
		amlProvider,
		simulationRunsProvider,
		simulationTestsProvider,
		testSource,
		onFiltererChange,
		allLanguageIds,
		theme,
		toggleTheme,
	}: ToolbarProps) => {

		return (
			<div style={{ padding: '5px', display: 'flex' }}>
				{(testSource.value === TestSource.Local)
					? <LocalModeToolbar
						initArgs={initArgs}
						runner={runner}
						runnerOptions={runnerOptions}
						simulationRunsProvider={simulationRunsProvider}
						simulationTestsProvider={simulationTestsProvider}
						onFiltererChange={onFiltererChange}
					/>
					: <AMLModeToolbar
						amlProvider={amlProvider}
						simulationTestsProvider={simulationTestsProvider}
						onFiltererChange={onFiltererChange}
						allLanguageIds={allLanguageIds}
					/>}
				<div style={{ display: 'flex', justifyContent: 'end', maxHeight: '35px' }}>
					<ThemeToggler theme={theme} toggleTheme={toggleTheme} />
					<ModeToggler testSource={testSource} onFiltererChange={onFiltererChange} />
				</div>
			</div>
		);
	}
);

const ThemeToggler = ({ theme, toggleTheme }: { theme: ThemeKind; toggleTheme: () => void }) => (
	<Tooltip content='Toggle workbench theme' relationship='label'>
		<ToggleButton
			appearance='subtle'
			icon={theme === 'dark' ? <WeatherSunny20Regular /> : <WeatherMoon20Regular />}
			onClick={toggleTheme}
		/>
	</Tooltip>
);

const ModeToggler = ({ testSource, onFiltererChange }: { testSource: TestSourceValue; onFiltererChange: (filter: TestFilterer | undefined) => void }) => (
	<Button
		appearance='secondary'
		style={{ marginLeft: '8px' }}
		onClick={mobx.action(() => {
			testSource.value = testSource.value === TestSource.External ? TestSource.Local : TestSource.External;
			onFiltererChange(undefined);
		})}
		title='Switch to workbench mode suited for viewing simulations in Azure ML'
	>
		Switch to {testSource.value === TestSource.Local ? 'AML' : 'Local'} mode
	</Button>
);
