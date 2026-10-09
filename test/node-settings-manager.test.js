/*eslint-disable no-undef */
//a jest.mock factory is hoisted above const declarations and may only close over a variable whose name starts with
//`mock`, so the spies are vars (the same pattern test/notifications-manager.test.js uses)
//eslint-disable-next-line no-var
var mockRegisterUsers = jest.fn().mockResolvedValue(undefined)
//eslint-disable-next-line no-var
var mockFindByIdAndUpdate = jest.fn((id, update) => ({
    exec: () => Promise.resolve({toPlainObject: () => ({pubkey: id, settings: update.$set.settings})})
}))
jest.mock('../domain/container', () => ({emailProvider: {registerUsers: mockRegisterUsers}}))
jest.mock('../logger', () => ({error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn()}))
jest.mock('../persistence-layer/models/node-settings', () => ({
    find: () => ({exec: () => Promise.resolve([])}),
    findByIdAndUpdate: mockFindByIdAndUpdate
}))

const {ValidationError} = require('@reflector/reflector-shared')
const NodeSettingsManager = require('../domain/node-settings-manager')

describe('NodeSettingsManager.update', () => {
    let manager

    beforeEach(async () => {
        mockRegisterUsers.mockClear()
        mockFindByIdAndUpdate.mockClear()
        manager = new NodeSettingsManager()
        await manager.init()
    })

    /**
     * @param {any} settings - the body handed to update
     * @param {string} message - the expected validation message
     * @returns {Promise<void>}
     */
    async function expectRefused(settings, message) {
        const error = await manager.update('GNODE', settings).then(() => null, e => e)
        //a ValidationError is what the server maps to a 400; anything else surfaces as a 500
        expect(error).toBeInstanceOf(ValidationError)
        expect(error.message).toContain(message)
    }

    function expectNothingRegisteredOrStored() {
        expect(mockRegisterUsers).not.toHaveBeenCalled()
        expect(mockFindByIdAndUpdate).not.toHaveBeenCalled()
        expect(manager.get('GNODE')).toEqual({})
    }

    test('refuses a body without an emails array', async () => {
        await expectRefused({}, 'emails must be an array')
        await expectRefused(null, 'emails must be an array')
        await expectRefused({emails: 'a@b.com'}, 'emails must be an array')
        expectNothingRegisteredOrStored()
    })

    test('refuses more addresses than the cap', async () => {
        const emails = new Array(6).fill(0).map((_, i) => `op${i}@example.com`)
        await expectRefused({emails}, 'at most 5')
        expectNothingRegisteredOrStored()
    })

    test('accepts exactly the cap', async () => {
        const emails = new Array(5).fill(0).map((_, i) => `op${i}@example.com`)
        await manager.update('GNODE', {emails})
        expect(mockRegisterUsers).toHaveBeenCalledTimes(1)
        expect(mockRegisterUsers).toHaveBeenCalledWith(emails)
        expect(manager.get('GNODE')).toEqual({emails})
    })

    test('refuses duplicates and malformed addresses', async () => {
        await expectRefused({emails: ['a@b.com', 'a@b.com']}, 'Duplicate emails')
        await expectRefused({emails: ['not-an-email']}, 'Invalid email')
        expectNothingRegisteredOrStored()
    })

    test('refuses the same address spelled in two cases', async () => {
        await expectRefused({emails: ['Ops@Example.com', 'ops@example.com']}, 'Duplicate emails')
        expectNothingRegisteredOrStored()
    })

    test('refuses an entry that is not a string even when it stringifies to an address', async () => {
        //the regex coerces its argument, so ['a@b.com'] would pass as the address a@b.com
        await expectRefused({emails: [['a@b.com']]}, 'Invalid email')
        await expectRefused({emails: [{toString: () => 'a@b.com'}]}, 'Invalid email')
        expectNothingRegisteredOrStored()
    })

    test('refuses an address longer than 254 characters', async () => {
        const email = 'a'.repeat(243) + '@example.com' //255 characters
        expect(email.length).toBe(255)
        await expectRefused({emails: [email]}, 'Invalid email')
        expectNothingRegisteredOrStored()
    })

    test('accepts a valid list and stores it', async () => {
        await manager.update('GNODE', {emails: ['a@b.com', 'c@d.com']})
        expect(mockRegisterUsers).toHaveBeenCalledWith(['a@b.com', 'c@d.com'])
        expect(manager.get('GNODE')).toEqual({emails: ['a@b.com', 'c@d.com']})
    })

    test('stores only the emails field, whatever else the settings object carries', async () => {
        await manager.update('GNODE', {emails: ['a@b.com'], cc: ['victim@example.com']})
        expect(mockFindByIdAndUpdate).toHaveBeenCalledTimes(1)
        expect(mockFindByIdAndUpdate.mock.calls[0][0]).toBe('GNODE')
        expect(mockFindByIdAndUpdate.mock.calls[0][1]).toEqual({$set: {settings: {emails: ['a@b.com']}}})
        expect(mockRegisterUsers).toHaveBeenCalledWith(['a@b.com'])
    })

    test('accepts an empty list, which clears the recipients', async () => {
        await manager.update('GNODE', {emails: ['a@b.com']})
        mockRegisterUsers.mockClear()
        await manager.update('GNODE', {emails: []})
        expect(mockRegisterUsers).not.toHaveBeenCalled()
        expect(manager.get('GNODE')).toEqual({emails: []})
    })

    test('a registration failure is a validation error and stores nothing', async () => {
        mockRegisterUsers.mockRejectedValueOnce(new Error('onesignal down'))
        await expectRefused({emails: ['a@b.com']}, 'Unable to register emails')
        expect(mockFindByIdAndUpdate).not.toHaveBeenCalled()
        expect(manager.get('GNODE')).toEqual({})
    })
})
