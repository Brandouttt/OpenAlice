import { describe, it, expect, beforeEach } from 'vitest'
import {
  register,
  getStrategy,
  listStrategies,
  _resetRegistryForTests,
} from './registry.js'
import type { RegisteredStrategy } from './types.js'
import type { Strategy } from '../backtest/types.js'

const noopStrategy: Strategy = async () => {}

function makeFixtureStrategy(
  name: string,
  overrides: Partial<RegisteredStrategy['metadata']> = {},
): RegisteredStrategy {
  return {
    metadata: {
      name,
      description: `${name} test fixture`,
      warmupBars: 10,
      defaults: {},
      parameters: [],
      ...overrides,
    },
    factory: () => noopStrategy,
  }
}

describe('strategy registry', () => {
  beforeEach(() => _resetRegistryForTests())

  it('registers and retrieves a strategy by name', () => {
    register(makeFixtureStrategy('alpha'))
    const got = getStrategy('alpha')
    expect(got).toBeDefined()
    expect(got!.metadata.name).toBe('alpha')
  })

  it('returns undefined for an unknown name', () => {
    expect(getStrategy('nonexistent')).toBeUndefined()
  })

  it('throws on duplicate name', () => {
    register(makeFixtureStrategy('alpha'))
    expect(() => register(makeFixtureStrategy('alpha'))).toThrow(/already registered/)
  })

  it('throws on empty name', () => {
    expect(() =>
      register(makeFixtureStrategy('', { name: '' })),
    ).toThrow(/non-empty/)
  })

  it('listStrategies returns metadata for every registration in order', () => {
    register(makeFixtureStrategy('alpha'))
    register(makeFixtureStrategy('beta'))
    register(makeFixtureStrategy('gamma'))
    const names = listStrategies().map(m => m.name)
    expect(names).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('listStrategies returns empty when registry is empty', () => {
    expect(listStrategies()).toEqual([])
  })

  it('factory is invoked fresh per call so strategy state does not leak', () => {
    let factoryCalls = 0
    const stateful: RegisteredStrategy = {
      metadata: makeFixtureStrategy('stateful').metadata,
      factory: () => {
        factoryCalls++
        return noopStrategy
      },
    }
    register(stateful)

    getStrategy('stateful')!.factory({})
    getStrategy('stateful')!.factory({})
    expect(factoryCalls).toBe(2)
  })
})
