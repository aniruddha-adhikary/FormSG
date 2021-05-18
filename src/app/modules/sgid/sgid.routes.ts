import { Router } from 'express'

import { handleLogin } from './sgid.controller'

export const SgidRouter = Router()

SgidRouter.get('/login', handleLogin)
