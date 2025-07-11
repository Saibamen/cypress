import systemTests from '../lib/system-tests'

import type { fixtureDirs } from '@tooling/system-tests'

type ProjectDirs = typeof fixtureDirs

// These versions should reflect the latest versions of each major version of Vite - update as needed
const VITE_REACT: ProjectDirs[number][] = ['vite4.5.12-react', 'vite5.4.18-react', 'vite6.2.5-react']

describe('@cypress/vite-dev-server', function () {
  systemTests.setup()

  describe('react', () => {
    for (const project of VITE_REACT) {
      it(`executes all of the specs for ${project}`, function () {
        return systemTests.exec(this, {
          project,
          configFile: 'cypress-vite.config.ts',
          testingType: 'component',
          browser: 'chrome',
          snapshot: true,
          expectedExitCode: 7,
        })
      })

      systemTests.it(`executes the port.cy.jsx spec for ${project} when port is statically configured`, {
        project,
        configFile: 'cypress-vite-port.config.ts',
        spec: 'src/port.cy.jsx',
        testingType: 'component',
        browser: 'chrome',
        snapshot: true,
        expectedExitCode: 0,
      })
    }
  })
})
