# Graph Report - .  (2026-09-29)

## Corpus Check
- Large corpus: 601 files · ~1,120,408 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder, or use --no-semantic to run AST-only.

## Summary
- 7231 nodes · 21701 edges · 280 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output
- Edge kinds: ON_BRANCH: 7593 · contains: 6104 · calls: 2827 · MODIFIES: 2207 · imports_from: 1548 · imports: 769 · PARENT_OF: 613 · rationale_for: 27 · method: 13


## Input Scope
- Requested: auto
- Resolved: committed (source: cli)
- Included files: 601 · Candidates: 630
- Excluded: 738 untracked · 32340 ignored · 8 sensitive · 0 missing committed
- Recommendation: Use --scope all or graphify.yaml inputs.corpus for a knowledge-base folder.

## Graph Freshness
- Built from Git commit: `a8bdd36`
- Compare this hash to `git rev-parse HEAD` before trusting freshness-sensitive graph output.
## God Nodes (most connected - your core abstractions)
1. `requireKeys()` - 49 edges
2. `logEvent()` - 36 edges
3. `requireSuperadmin()` - 33 edges
4. `runOnce()` - 28 edges
5. `sendTelegram()` - 23 edges
6. `apiError()` - 22 edges
7. `g2gRequest()` - 22 edges
8. `eldRequest()` - 20 edges
9. `buildSetGridImage()` - 20 edges
10. `BudgetCycle` - 19 edges

## Surprising Connections (you probably didn't know these)
- `07c52e9 chore(marketplaces): remove Z2U, FunPay and EpicNPC end to end` --ON_BRANCH--> `fix/eldorado-retry-keepalive`  [EXTRACTED]
  git → git  _Bridges community 25 → community 1_
- `13742eb Merge pull request #35 from AvishkaNilupul/devin/prod-live-sync-2026-08-03` --ON_BRANCH--> `claude/compassionate-mclaren-6a058b`  [EXTRACTED]
  git → git  _Bridges community 2 → community 1_
- `1bb1d71 Merge branch 'fix/fresh-account-gate' into feat/noclaim-shop-listings` --PARENT_OF--> `fbfcef0 feat(listings): sell no-claim farm drops from Shop listings with auto-delivery`  [EXTRACTED]
  git → git  _Bridges community 0 → community 9_
- `27ed11b feat(do): DigitalOcean server creator in the admin panel` --ON_BRANCH--> `feat/pa-session-one-click-and-reminder`  [EXTRACTED]
  git → git  _Bridges community 118 → community 0_
- `27ed11b feat(do): DigitalOcean server creator in the admin panel` --PARENT_OF--> `a8bdd36 fix(pool): accept a bulk import paste instead of a bare HTTP 413`  [EXTRACTED]
  git → git  _Bridges community 118 → community 148_

## Communities

### Community 0 - "Community 0"
Cohesion: 0.08
Nodes (366): chore/cross-host-bot-migration, farm2-reuse-account-gap-apply, feat/account-listings, feat/account-listings-from-drops, feat/bulk-packs, feat/eldorado-marketplace, feat/fleet-sizing, feat/noclaim-listing-drift-check (+358 more)

### Community 1 - "Community 1"
Cohesion: 0.05
Nodes (294): claude/compassionate-mclaren-6a058b, feature/do-server-creator, fix/ban-alerts-recycle-scope, fix/eldorado-retry-keepalive, fix/farm-image-missing-alert, fix/farm-tag-autorestore, fix/sweep-0927-farm-catalog-health, main (+286 more)

### Community 2 - "Community 2"
Cohesion: 0.02
Nodes (115): 13742eb Merge pull request #35 from AvishkaNilupul/devin/prod-live-sync-2026-08-03, a18a779 Sync live production code state to GitHub (backup), bb0419e auto-farm: never spend fresh pool accounts on reuse-only games (WoT, UFL), enforce2fa(), isTfaEnrollmentPath(), requireSuperadmin(), TFA_EXEMPT_PATHS, TFA_EXEMPT_PREFIXES (+107 more)

### Community 3 - "Community 3"
Cohesion: 0.03
Nodes (108): crypto, dsCatCache, dsToken, ELD_GAME_ALIASES, eldTalkTokenCache, eldTradeEnvCache, { encrypt, decrypt }, FIELDS (+100 more)

### Community 4 - "Community 4"
Cohesion: 0.02
Nodes (106): accountApiRoutes, accountListingRoutes, accountPoolChecker, accountPoolRoutes, activityRoutes, adminAuthRoutes, adminManageRoutes, aiChatRoutes (+98 more)

### Community 5 - "Community 5"
Cohesion: 0.04
Nodes (64): 912f555 feat(rent-farm): rebalance stacks to 50, and let a brand-new stack be used, 9e9062e fix(rent-farm): a stack with free slots is not a stack that can farm, dc3ec81 feat(rent-farm): move a renter stack between hosts without stranding its ledger, mongoose, renterBotStackSchema, { logEvent }, MarketplaceListing, mongoose (+56 more)

### Community 6 - "Community 6"
Cohesion: 0.06
Nodes (69): activeAutoBotCount(), archiveHoldersByGame(), archiveHoldersForCampaign(), AutoFarmTask, autoSeatCapacity(), AvailableAccount, backfillActiveTasks(), botFactory (+61 more)

### Community 7 - "Community 7"
Cohesion: 0.05
Nodes (62): autoFarmSnapshotSchema, mongoose, assert, { FRESH_MS, classifyBotCompletion }, goodCompletion, {
  HOST_STALE_MS,
  WATCHER_FRESH_MS,
  farmingRollup,
  deriveBotState,
  decisionSummary,
  buildPayload,
  mergeHostResult,
  allAutoBotKeys,
}, NOW, RUNNING (+54 more)

### Community 8 - "Community 8"
Cohesion: 0.05
Nodes (60): APPLY, args, DELAY_MS, DELISTERS, { isNoClaimGame }, { loginsOnActiveListings, notListed }, mongoose, mp (+52 more)

### Community 9 - "Community 9"
Cohesion: 0.05
Nodes (59): fbfcef0 feat(listings): sell no-claim farm drops from Shop listings with auto-delivery, assert, {
  relistRetryDelayMs,
  isOutOfStockError,
  RELIST_RETRY_MAX_MS,
}, test, BotAccount, clearEmptyShadows(), DropLog, emptyReservation() (+51 more)

### Community 10 - "Community 10"
Cohesion: 0.04
Nodes (52): ARCHIVE_HELD_STATUSES, ARCHIVE_SOURCES, ARCHIVE_STATUS_ZERO, AvailableAccount, BotAccount, { buildSetGridImage }, { classifyKind }, collectNoClaimCandidates() (+44 more)

### Community 11 - "Community 11"
Cohesion: 0.04
Nodes (52): AccountOffer, AuditFinding, { buildG2gBulkFile }, {
  buildSetGridImage,
  buildPromoCoverImage,
}, { competitorPrices }, DropLog, DropSet, dsFulfiller (+44 more)

### Community 12 - "Community 12"
Cohesion: 0.04
Nodes (47): addAccountsToConfig(), addRenterAccountsToConfig(), countConfigAccounts(), dedupeAccounts(), getConfigGames(), provisionEmptyConfig(), removeAccountFromConfig(), setConfigGames() (+39 more)

### Community 13 - "Community 13"
Cohesion: 0.05
Nodes (49): denyBlocked(), { getById, isBlocked }, requireRenter(), wantsHtml(), mongoose, renterSubmissionSchema, containerForFile(), getAccountGames() (+41 more)

### Community 14 - "Community 14"
Cohesion: 0.04
Nodes (40): ARCHIVE_BUST_PREFIXES, archiveSnapshot, AvailableAccount, {
  BAD_STATUSES,
  excludedAccountIdsCached,
  invalidateExclusions,
}, BotAccount, bustDropCache(), bustTargets(), { cacheImage } (+32 more)

### Community 15 - "Community 15"
Cohesion: 0.05
Nodes (50): arg(), audit, buildDescription(), buildTitle(), coverage, declare(), fmtItems(), has() (+42 more)

### Community 16 - "Community 16"
Cohesion: 0.05
Nodes (47): balanceLogSchema, mongoose, BalanceLog, express, {
  loadAdmins,
  sanitizeAdmin,
  addAdmin,
  updateAdmin,
  deleteAdmin,
  adjustBalance,
  setBalance,
  getBalance,
  getAdminById,
}, { requireSuperadmin }, router, express (+39 more)

### Community 17 - "Community 17"
Cohesion: 0.04
Nodes (51): accountState, adminOverview(), AutoFarmTask, { AVAILABLE_DROP }, BotAccount, {
  buildCatalogProfilePlan,
  DEFAULT_MIN_STOCK,
  DEFAULT_MAX_PROFILES_PER_GAME,
}, buildPublicCatalog(), CatalogEvent (+43 more)

### Community 18 - "Community 18"
Cohesion: 0.05
Nodes (41): availableAccountSchema, mongoose, mongoose, poolUsageEventSchema, assert, owFinals, {
  STOCK_NOTE_PREFIX,
  inventoryHoldings,
  freshnessVerdict,
  stockNote,
  isStockNote,
  verifyFreshLive,
  placeFirstFresh,
}, test (+33 more)

### Community 19 - "Community 19"
Cohesion: 0.05
Nodes (43): accountIdsForScope(), accountState, {
  AVAILABLE_DROP,
  reserveSetOnAccount,
  releaseAccountsForTag,
  releaseSetForAccounts,
}, availableAccountsForSet(), BalanceLog, BotAccount, connectableLoadForAccounts(), { decrypt } (+35 more)

### Community 20 - "Community 20"
Cohesion: 0.07
Nodes (46): assert, { buildEventCatalog }, {
  bundleSetName,
  bundleTitleFor,
  classificationFor,
  placeTask,
  planEventBundles,
  planForTask,
  signatureOf,
  tidyEventName,
  waveLabels,
  waveStarted,
}, CAMPAIGNS, CATALOG, MANIFESTS, NOW, test (+38 more)

### Community 21 - "Community 21"
Cohesion: 0.08
Nodes (49): ALL_HOSTS, botctl(), COMPOSE_NAMES, _composeCmd, composeName(), composeRead(), composeUp(), composeWrite() (+41 more)

### Community 22 - "Community 22"
Cohesion: 0.06
Nodes (50): accountState, backfillItemKeys(), BotAccount, botHosts, { cacheImage }, claimNext(), DROP_UPSERT_CONCURRENCY, DropLog (+42 more)

### Community 23 - "Community 23"
Cohesion: 0.06
Nodes (43): denyBlocked(), { getById, isBlocked }, requireReseller(), wantsHtml(), mongoose, resellerSchema, mongoose, resellerAuditSchema (+35 more)

### Community 24 - "Community 24"
Cohesion: 0.06
Nodes (42): inventorySchema, mongoose, itemSchema, mongoose, messageSchema, mongoose, mongoose, orderSchema (+34 more)

### Community 25 - "Community 25"
Cohesion: 0.06
Nodes (42): 07c52e9 chore(marketplaces): remove Z2U, FunPay and EpicNPC end to end, 4864032 fix(eldorado): keep-alive report states the due count, 70b4202 snapshot: production code bytes (2026-09-29, no secrets/config), 727d34a fix(eldorado): retry Eldorado shares, keep offers alive, unbreak research, d26ddbb docs(bulk-packs): frozen v1 contract, module APIs, API/UI plan, banner(), fill(), setVal() (+34 more)

### Community 26 - "Community 26"
Cohesion: 0.06
Nodes (35): assert, ful, LIVE, mp, test, tmpl, attributeSheetRows(), buildG2gBulkFile() (+27 more)

### Community 27 - "Community 27"
Cohesion: 0.05
Nodes (32): ownership, settings, supervisor, TRIAL_GAMES, farmJobSchema, mongoose, farmLaneSchema, mongoose (+24 more)

### Community 28 - "Community 28"
Cohesion: 0.06
Nodes (36): express, {
  getMessagesBySeller,
  getMessagesByUser,
  clearChat,
  markRead,
  getSellerUserIds,
  getSellerConversations,
  getAllConversations,
}, isSuper(), router, sellerScope(), express, {
  getOrdersBySeller,
  getAllOrders,
  addOrder,
  deleteOrder,
  deleteAnyOrder,
}, router (+28 more)

### Community 29 - "Community 29"
Cohesion: 0.07
Nodes (39): mongoose, twitchCampaignSchema, AF, AF_COLD, assert, autoFarmer, AutoFarmTask, BotAccount (+31 more)

### Community 30 - "Community 30"
Cohesion: 0.08
Nodes (39): accts, assert, campaigns, cfg, { classifyBotCompletion }, GAMES, {
  liveWakeTrigger,
  liveIsFresh,
  isGateableGame,
  gatedDark,
  gameMatchesCampaign,
}, settings (+31 more)

### Community 31 - "Community 31"
Cohesion: 0.07
Nodes (38): accountState, assert, { purgePlanFor }, test, assert, { fixPlanFor }, { listingRefsAccount }, test (+30 more)

### Community 32 - "Community 32"
Cohesion: 0.06
Nodes (32): marketplaceListingSchema, mongoose, DropSet, liveStatus(), MarketplaceListing, mongoose, mp, { recordListingSale } (+24 more)

### Community 33 - "Community 33"
Cohesion: 0.07
Nodes (37): BotAccount, BulkOrder, buyerLink(), buyerUnitsView(), crypto, { decrypt }, DropSet, express (+29 more)

### Community 34 - "Community 34"
Cohesion: 0.10
Nodes (41): assert, settings, test, ACCOUNT_LISTING_DEFAULTS, AUTO_FARM_DEFAULTS, catalogHandle(), catalogMinutes(), catalogString() (+33 more)

### Community 35 - "Community 35"
Cohesion: 0.08
Nodes (42): alertBufferStopped(), AvailableAccount, botConfig(), bufferedDeliveryCode(), bufferState(), { buildPromoCoverImage }, catalogueGames(), config() (+34 more)

### Community 36 - "Community 36"
Cohesion: 0.12
Nodes (40): analyseEvent(), buildEventCatalog(), BULK_QTY_MARKETS, bundleDescriptionLines(), bundleTitle(), clampTitle(), classifyHoldings(), countBit() (+32 more)

### Community 37 - "Community 37"
Cohesion: 0.05
Nodes (31): botAccountSchema, mongoose, dropSetItemSchema, dropSetSchema, mongoose, AvailableAccount, BotAccount, DropSet (+23 more)

### Community 38 - "Community 38"
Cohesion: 0.12
Nodes (41): apiError(), digisellerProductVisible(), gameflipDeleteNonCoverPhotos(), gameflipDelist(), gameflipListingIdsByStatus(), gameflipListingStatus(), gameflipOwnerId(), gameflipPublish() (+33 more)

### Community 39 - "Community 39"
Cohesion: 0.10
Nodes (39): advertisedItems(), applyRebundle(), applyStock(), archiveStockForSet(), auditAll(), auditGame(), auditShop(), BotAccount (+31 more)

### Community 40 - "Community 40"
Cohesion: 0.07
Nodes (35): archiveRollupSchema, mongoose, accountState, AvailableAccount, badAccountIds(), BotAccount, excludedAccountIds(), excludedAccountIdsCached() (+27 more)

### Community 41 - "Community 41"
Cohesion: 0.05
Nodes (35): autoFarmEventSchema, mongoose, assert, AutoFarmEvent, { MongoMemoryServer }, mongoose, { recordAutoFarmEvent }, test (+27 more)

### Community 42 - "Community 42"
Cohesion: 0.08
Nodes (32): campaignDropsSchema, mongoose, assert, { dropIdentity }, { itemKeyFor }, test, borrowToken(), BotAccount (+24 more)

### Community 43 - "Community 43"
Cohesion: 0.06
Nodes (30): codeSchema, mongoose, bcrypt, express, { loadAdmins }, { loginLimiter }, router, settings (+22 more)

### Community 44 - "Community 44"
Cohesion: 0.06
Nodes (33): AvailableAccount, BotAccount, { buildSetGridImage }, { buildSocialPost }, connectedForGame(), connectedGamesFor(), coverStem(), { decrypt } (+25 more)

### Community 45 - "Community 45"
Cohesion: 0.06
Nodes (31): dropLogSchema, mongoose, accountPoolChecker, AvailableAccount, BotAccount, DropLog, dropScanner, { encrypt, decrypt } (+23 more)

### Community 46 - "Community 46"
Cohesion: 0.06
Nodes (36): accountState, autoFarmBundles, AutoFarmTask, BotAccount, { brandForGame }, { buildSetGridImage }, bundlePlanCache, bundleWaitCache (+28 more)

### Community 47 - "Community 47"
Cohesion: 0.07
Nodes (31): auditFindingSchema, mongoose, assert, {
  healEligibility,
  isStaleSupplyFinding,
  MAX_ATTEMPTS,
}, hoursAgo(), OLD, { pickDuplicateLoser }, supply() (+23 more)

### Community 48 - "Community 48"
Cohesion: 0.06
Nodes (25): accountState, AvailableAccount, BotAccount, DEAD_STATUSES, { decrypt }, DropLog, express, { MARKET_CLAIM_TAGS } (+17 more)

### Community 49 - "Community 49"
Cohesion: 0.08
Nodes (33): AvailableAccount, BotAccount, DEAD_TOKEN_STATUSES, DropLog, dropRollupPipeline(), dropScanner, express, gatherSpentAccounts() (+25 more)

### Community 50 - "Community 50"
Cohesion: 0.08
Nodes (17): BudgetCycle, computeCycleBudget(), safeFarmSizing(), assert, { BudgetCycle }, test, assert, AutoFarmTask (+9 more)

### Community 51 - "Community 51"
Cohesion: 0.07
Nodes (24): doLoad(), load(), render(), renderPager(), assert, boot(), CONTRACT, DIR (+16 more)

### Community 52 - "Community 52"
Cohesion: 0.07
Nodes (32): accountIdsForLogins(), assignedLogins(), AutoFarmTask, { AVAILABLE_DROP }, { availableAccountsForSet }, BotAccount, { buildRadarEvents }, { cacheImage } (+24 more)

### Community 53 - "Community 53"
Cohesion: 0.07
Nodes (29): assert, AvailableAccount, checker, { MongoMemoryServer }, mongoose, test, accountState, activeHosts (+21 more)

### Community 54 - "Community 54"
Cohesion: 0.09
Nodes (30): assert, { execFileSync }, NOW, test, w, cfg(), checkHost(), checkRuntime() (+22 more)

### Community 55 - "Community 55"
Cohesion: 0.10
Nodes (30): assert, { gameflipDeliveryCode }, {
  pickLotMembers,
  eligibleLotLedgers,
  buildLotCode,
  lotTitle,
  lotDescription,
  lotPriceFor,
  LOT_SEPARATOR,
}, test, breakLot(), buildLotCode(), { buildSetGridImage }, checkLots() (+22 more)

### Community 56 - "Community 56"
Cohesion: 0.14
Nodes (32): addAccounts(), archiveLogins(), chunk(), claimForListing(), contentIdResolver(), deliveryEnabled(), deliveryText(), dep() (+24 more)

### Community 57 - "Community 57"
Cohesion: 0.07
Nodes (24): gogAccountSchema, mongoose, mongoose, primeKeySchema, mongoose, primeOfferSchema, { encrypt, decrypt }, express (+16 more)

### Community 58 - "Community 58"
Cohesion: 0.07
Nodes (26): postEventChecked, publishStep, verifyStep, lister(), notify, publishPrimary(), publishSecondaries(), { recordAutoFarmEvent } (+18 more)

### Community 59 - "Community 59"
Cohesion: 0.06
Nodes (30): assert, autoFarmer, AutoFarmEvent, AutoFarmTask, autoLister, botFactory, botWaker, budget (+22 more)

### Community 60 - "Community 60"
Cohesion: 0.11
Nodes (34): eldAbsorbCookies(), eldCookieJar(), eldError(), eldInternalId(), eldJarHeader(), eldNorm(), eldNymId(), eldoradoDeleteOffer() (+26 more)

### Community 61 - "Community 61"
Cohesion: 0.07
Nodes (26): telegram, budget, ensureLanesForLiveGames(), jobs, lane, mapWithConcurrency(), notify, ownership (+18 more)

### Community 62 - "Community 62"
Cohesion: 0.11
Nodes (28): assert, { fixPlanFor }, test, accountState, AuditFinding, BotAccount, claimFreshAccount(), DropLog (+20 more)

### Community 63 - "Community 63"
Cohesion: 0.09
Nodes (24): BY_NAME, clamp(), db_count(), db_group(), db_query(), event_summary(), { execFile }, fleet_trend() (+16 more)

### Community 64 - "Community 64"
Cohesion: 0.09
Nodes (32): BACKUP_HOUR, BACKUP_MINUTE, backupPath(), copyDir(), createBackup(), createBackupUnlocked(), crypto, deleteBackup() (+24 more)

### Community 65 - "Community 65"
Cohesion: 0.11
Nodes (30): alerted, alertSentAwaitingConfirm(), alertsOperator(), alertUnshippable(), buildMessage(), chat, confirmAsked, confirmOnG2g() (+22 more)

### Community 66 - "Community 66"
Cohesion: 0.09
Nodes (33): parseZ2uForm(), parseZ2uGroups(), parseZ2uOffers(), parseZ2uOrders(), z2uAbsorbCookies(), z2uAjax(), z2uAllOffers(), z2uAllOrders() (+25 more)

### Community 67 - "Community 67"
Cohesion: 0.08
Nodes (25): marketResearchSchema, mongoose, ARCHIVE_ACCOUNT_PROJECTION, audit, DropSet, dropsForClassification(), engine, eventsForGame() (+17 more)

### Community 68 - "Community 68"
Cohesion: 0.10
Nodes (27): assert, {
  decideActions,
  resolveWithHysteresis,
  _state,
}, test, aclCache, aclChannels(), activeNoClaimCampaigns(), anyChannelLive(), applyActions() (+19 more)

### Community 69 - "Community 69"
Cohesion: 0.10
Nodes (29): e459102 fix(autolist): don't reject non-Latin or campaign-named drop items, assert, ASSIGNED, backed, {
  buildTitle,
  buildDescription,
  derivePrice,
  stackItems,
  chooseStackItems,
  postEventPrice,
  computeSplit,
  isAutoOwned,
  normLabel,
  looksLikeTitlePlaceholder,
  resolveCampaignItems,
  filterVerifiedHolders,
  withReservationRollback,
}, { itemKeyFor }, items, NEED (+21 more)

### Community 70 - "Community 70"
Cohesion: 0.10
Nodes (26): activeListingFor(), assignmentReport(), assignOne(), audit(), badId(), BotAccount, connectSnapshot(), {
  createReseller,
  setPassword,
  revealPassword,
  sanitizeReseller,
  parseAccessDate,
} (+18 more)

### Community 71 - "Community 71"
Cohesion: 0.09
Nodes (20): assert, find(), query(), {
  stampPreorderSet,
  syncActivePreorders,
  syncHistoricalEventSets,
}, test, assert, {
  computePreorderEta,
  STALE_PROGRESS_MS,
}, test (+12 more)

### Community 72 - "Community 72"
Cohesion: 0.08
Nodes (25): accountGap, af(), assert, autoFarmer, AutoFarmTask, BOT, botFactory, botWaker (+17 more)

### Community 73 - "Community 73"
Cohesion: 0.10
Nodes (22): assert, { gamesForUser }, {
  removeUsersBySecret,
  addUsersDedupe,
  setUsersGamesBySecret,
}, test, chains, keyFor(), withFileLock(), addUsersDedupe() (+14 more)

### Community 74 - "Community 74"
Cohesion: 0.09
Nodes (26): 79f2270 feat(twitch-inventory): look an account up by username, not just by token, callerIp(), express, handleLookup(), { logEvent }, { lookupAccountByUsername }, { requireApiToken }, router (+18 more)

### Community 75 - "Community 75"
Cohesion: 0.09
Nodes (10): accountRows(), cancelQuickFarmLookups(), cancelTokenLookup(), dateVal(), loadRenterOptions(), loadRenters(), open(), renderModal() (+2 more)

### Community 76 - "Community 76"
Cohesion: 0.09
Nodes (25): recommendedProfilePrice(), assert, { recommendedProfilePrice }, {
  signatureForItems,
  sourceEventKeyFor,
}, test, { thumbnailUrl }, ensureThumbnail(), fs (+17 more)

### Community 77 - "Community 77"
Cohesion: 0.09
Nodes (22): alert, assert, test, linkTelegramByCode(), { logEvent }, { sendTelegram }, axios, getMe() (+14 more)

### Community 78 - "Community 78"
Cohesion: 0.11
Nodes (27): 2d47724 fix(park): an account that could not evaluate a campaign is not finished, 440e294 Sync botHealthMonitor/botUpdater/noclaimFleet to the bytes live on prod, c8bf1aa fix(health): count decay over the whole window; alarm on GQL parse errors, checkContainer(), checkDecay(), checkHost(), countActiveUsernames(), countEnabled() (+19 more)

### Community 79 - "Community 79"
Cohesion: 0.11
Nodes (21): { aggregateForecast }, assert, test, aggregateForecast(), AutoFarmTask, BotAccount, cache, confidenceFor() (+13 more)

### Community 80 - "Community 80"
Cohesion: 0.10
Nodes (26): assert, test, { zeusxDetachPlan }, { buildSetGridImage }, detachAccountFromListing(), detachAccountFromRow(), DropSet, gfFulfiller (+18 more)

### Community 81 - "Community 81"
Cohesion: 0.11
Nodes (23): 346535c sync: live prod bytes of the system-health subsystem, 3d28aed fix(auto-farm,catalog,health): keep the next wave armed, drop retired bots, batch the catalog plan, ago(), assert, capacityCases, CAPPED_200, cmp(), eq() (+15 more)

### Community 82 - "Community 82"
Cohesion: 0.14
Nodes (26): a01cb4a feat(noclaim): roll a new bot build out to the whole no-claim fleet, assertNoClaimGame(), AvailableAccount, botDir(), buildConfig(), claimForGame(), configPath(), containerFor() (+18 more)

### Community 83 - "Community 83"
Cohesion: 0.08
Nodes (15): coworkerLogSchema, mongoose, coworkerProposalSchema, mongoose, CoworkerChat, CoworkerLog, CoworkerMemory, CoworkerProposal (+7 more)

### Community 84 - "Community 84"
Cohesion: 0.08
Nodes (21): bufferCache, bufferRows(), bufferSnapshot(), CATEGORIES, COMMON_TABS, express, EXTRA_TABS, FarmServiceOrder (+13 more)

### Community 85 - "Community 85"
Cohesion: 0.10
Nodes (22): campaignLiveStateSchema, mongoose, aclCache, aclChannels(), activeCampaigns(), anyChannelLive(), borrowTokens(), BotAccount (+14 more)

### Community 86 - "Community 86"
Cohesion: 0.08
Nodes (20): marketResearchSnapshotSchema, mongoose, af(), assert, autoFarmer, AutoFarmTask, { BudgetCycle }, decideStep (+12 more)

### Community 87 - "Community 87"
Cohesion: 0.22
Nodes (25): api(), bar(), days(), esc(), fmtDate(), fmtDay(), kpi(), kv() (+17 more)

### Community 88 - "Community 88"
Cohesion: 0.11
Nodes (24): assert, {
  delistVerdict,
  delistRowVerified,
  supersededRowIds,
  reconcileRowPlan,
  withSetMarketLock,
}, test, activeRowForSetMarket(), addUnitToRow(), credentialForLedger(), delistRowsForAccount(), delistRowVerified() (+16 more)

### Community 89 - "Community 89"
Cohesion: 0.11
Nodes (27): allFields(), axios, g2gEnsureFreshToken(), g2gError(), g2gRefreshAccess(), g2gTokenMsLeft(), getKeys(), paAbsorbCookies() (+19 more)

### Community 90 - "Community 90"
Cohesion: 0.11
Nodes (24): candidateGames(), DropLog, DropSet, dueGames(), FRESHNESS_MS, freshnessFor(), funpayNodeMap(), {
  gameflipScout,
  gameflipSoldScout,
  platiScout,
  ggselScout,
  funpayScout,
} (+16 more)

### Community 91 - "Community 91"
Cohesion: 0.11
Nodes (26): AvailableAccount, canonicalGame(), copy, credentialsFor(), { decrypt }, deliverFarmOrder(), farmAlert, farmOrderKey() (+18 more)

### Community 92 - "Community 92"
Cohesion: 0.11
Nodes (25): alertedOrders, alertsOperator(), alertUnfulfillable(), { availableAccountsForSet }, daysUntilExpiry(), deliverPendingOrders(), deliverTick(), DropSet (+17 more)

### Community 93 - "Community 93"
Cohesion: 0.10
Nodes (21): ACCOUNT_STATUSES, applyOfferBody(), { buildPromoCoverImage }, deps(), DropLog, express, fsp, listingsForOffers() (+13 more)

### Community 94 - "Community 94"
Cohesion: 0.13
Nodes (19): assert, {
  MARKETPLACE_LABELS,
  PRIVATE_KEYS,
  signatureFor,
  deriveTitle,
  dedupeListings,
  unclaimedSummary,
  buyLinksFor,
  scheduleEta,
  assertPublicShape,
}, test, assertPublicShape(), beatsRepresentative(), buyLinksFor(), capTitle(), dedupeListings() (+11 more)

### Community 95 - "Community 95"
Cohesion: 0.08
Nodes (20): connectSummarySchema, mongoose, resellerAccountSchema, assert, BotAccount, { createReseller }, DropLog, { encrypt } (+12 more)

### Community 96 - "Community 96"
Cohesion: 0.09
Nodes (21): ALL, APPLY, args, autoLister, { brandForGame }, has(), { isNoClaimGame }, itemSignature() (+13 more)

### Community 97 - "Community 97"
Cohesion: 0.10
Nodes (22): accounts(), af(), assert, autoFarmer, AutoFarmTask, BOT, botFactory, botWaker (+14 more)

### Community 98 - "Community 98"
Cohesion: 0.09
Nodes (16): BACKOFF_MS, backoffFor(), claimDueForLane(), claimNext(), fail(), FarmJob, assert, FarmJob (+8 more)

### Community 99 - "Community 99"
Cohesion: 0.13
Nodes (20): {
  addServiceToComposeText,
  removeServiceFromComposeText,
  usedSeats,
}, assert, BASE_COMPOSE, test, addAccountsToBot(), addServiceToComposeText(), BotAccount, containerForFile() (+12 more)

### Community 100 - "Community 100"
Cohesion: 0.14
Nodes (23): assert, {
  digisellerFloorPrice,
  DS_MIN_PRICE_USD,
}, test, digisellerAddContent(), digisellerCategories(), digisellerCategoryAttributes(), digisellerDelist(), digisellerFloorPrice() (+15 more)

### Community 101 - "Community 101"
Cohesion: 0.20
Nodes (22): assert, {
  DEFAULTS,
  MARKETPLACE_FLOORS,
  bundleMultiplier,
  floorForMarketplace,
  median,
  priceBand,
  priceListing,
  resolveAnchor,
  shouldReprice,
}, GAMEFLIP_SALES, test, ANCHOR_LADDER, bundleMultiplier(), cents(), cfg() (+14 more)

### Community 102 - "Community 102"
Cohesion: 0.14
Nodes (21): apiOk(), axios, buildUserData(), cfg(), config, createDroplet(), defaultRequest(), deployStatus() (+13 more)

### Community 103 - "Community 103"
Cohesion: 0.11
Nodes (14): capItems(), CHECKS, FARM_SERVICE_MARKETS, LOOP_BUDGETS, makeCtx(), normStatus(), REAL_DEPS, rollup() (+6 more)

### Community 104 - "Community 104"
Cohesion: 0.12
Nodes (21): activeLoops, attemptFollow(), BotAccount, buildCandidatePool(), enqueueJob(), hosts, incJobCounters(), markTerminalAtomic() (+13 more)

### Community 105 - "Community 105"
Cohesion: 0.15
Nodes (22): _build_description(), Category, debrand(), _fetch(), fetch_catalog(), Game, _offer_id(), parse_price() (+14 more)

### Community 106 - "Community 106"
Cohesion: 0.11
Nodes (21): assert, farm, mp, test, AvailableAccount, canonicalGame(), credentialsFor(), { decrypt } (+13 more)

### Community 107 - "Community 107"
Cohesion: 0.10
Nodes (19): assert, AutoFarmTask, campaign(), classes, coverage, executeStep, FarmJob, FarmLane (+11 more)

### Community 108 - "Community 108"
Cohesion: 0.16
Nodes (20): appliedVersions(), axios, BAD_LOG_PATTERNS, buildAndRolloutHost(), buildDir(), hosts, latestArmAsset(), latestRelease() (+12 more)

### Community 109 - "Community 109"
Cohesion: 0.16
Nodes (23): g2gAttributesFromOwnOffers(), g2gChatProfile(), g2gCollections(), g2gDeliveries(), g2gDeliveryProofs(), g2gGetOffer(), g2gListOffers(), g2gMarkDelivering() (+15 more)

### Community 110 - "Community 110"
Cohesion: 0.16
Nodes (20): AUTH_STATUSES, blockedPhrase(), callWithBudget(), classify(), connectorCheck(), connectorChecks(), describeOutcome(), errorFromResult() (+12 more)

### Community 111 - "Community 111"
Cohesion: 0.13
Nodes (21): backoffMs(), candidatesFor(), classes, decideStep, decisionDue(), drainJobs(), executeStep, existingRowsFor() (+13 more)

### Community 112 - "Community 112"
Cohesion: 0.14
Nodes (18): mongoose, noclaimSpentAccountSchema, AvailableAccount, bucketFor(), bucketLabel(), MarketplaceListing, noClaimKeys(), NoclaimSpentAccount (+10 more)

### Community 113 - "Community 113"
Cohesion: 0.12
Nodes (13): mongoose, systemHealthRunSchema, ageMs(), cooldownRemaining(), countStatuses(), express, normalizeRun(), { requireSuperadmin, enforce2fa } (+5 more)

### Community 114 - "Community 114"
Cohesion: 0.12
Nodes (9): copy(), esc(), farmCell(), fmtDate(), modalEl(), openModal(), remaining(), secret() (+1 more)

### Community 115 - "Community 115"
Cohesion: 0.10
Nodes (20): APP, APPLY, AutoFarmTask, bc, BotAccount, cons, DEDUPE, DEST (+12 more)

### Community 116 - "Community 116"
Cohesion: 0.09
Nodes (17): AccountOffer, assert, calls, DropSet, DS_AUTO, express, GG_AUTO, ggFulfiller (+9 more)

### Community 117 - "Community 117"
Cohesion: 0.14
Nodes (19): assert, id, test, activeWindowFor(), APP_VERSIONS, appVersionFor(), CHROME_BUILDS, crypto (+11 more)

### Community 118 - "Community 118"
Cohesion: 0.11
Nodes (15): 27ed11b feat(do): DigitalOcean server creator in the admin panel, 7339a10 feat(do): DigitalOcean server creator in the admin panel, e46f6be snapshot: prod bytes of server.js, config/config.js, public/admin-nav.js, digitalOcean, express, KNOWN_REGIONS, { requireSuperadmin }, router (+7 more)

### Community 119 - "Community 119"
Cohesion: 0.10
Nodes (14): farmServiceOrderSchema, mongoose, FarmServiceOrder, { logEvent }, mongoose, OPEN, assert, farm (+6 more)

### Community 120 - "Community 120"
Cohesion: 0.10
Nodes (16): audit(), BotAccount, clientIp(), { decrypt }, DropLog, express, { isExpired }, mongoose (+8 more)

### Community 121 - "Community 121"
Cohesion: 0.11
Nodes (17): af(), assert, AutoFarmTask, AvailableAccount, { BudgetCycle }, classes, decide(), decideStep (+9 more)

### Community 122 - "Community 122"
Cohesion: 0.10
Nodes (16): accounts(), assert, AutoFarmTask, BOT, decideStep, executeStep, FarmJob, FarmLane (+8 more)

### Community 123 - "Community 123"
Cohesion: 0.10
Nodes (16): AccountOffer, assert, calls, DropSet, express, GG_AUTO, ggFulfiller, MarketplaceListing (+8 more)

### Community 124 - "Community 124"
Cohesion: 0.18
Nodes (14): archiveSpies(), assert, eldEnv(), fakeById(), fakeListingModel(), g2gEnv(), Module, OWNER_OFFER (+6 more)

### Community 125 - "Community 125"
Cohesion: 0.16
Nodes (19): axios, cache, cacheGet(), cacheSet(), competitorPrices(), decodeEntities(), extractJsonObjects(), fpField() (+11 more)

### Community 126 - "Community 126"
Cohesion: 0.13
Nodes (19): APPLY, AvailableAccount, { buildSetGridImage }, { decrypt }, DropSet, engine, fsp, GGSEL_REPUBLISH (+11 more)

### Community 127 - "Community 127"
Cohesion: 0.10
Nodes (16): ALL, APP, APPLY, bc, COUNT, FROM, hosts, { logEvent } (+8 more)

### Community 128 - "Community 128"
Cohesion: 0.22
Nodes (18): brain(), {
  buildDecisionInputs,
  buildReuseInputs,
  withReuseInputs,
}, classes, { compareAccounts }, coverageFor(), decideCampaign(), emptyStash(), escapeRe() (+10 more)

### Community 129 - "Community 129"
Cohesion: 0.12
Nodes (16): API, assert, CLAIMABLE, DS_PICK, fs, G2G_PICK, GG_PICK, html (+8 more)

### Community 130 - "Community 130"
Cohesion: 0.11
Nodes (17): assert, AutoFarmEvent, AutoFarmTask, autoLister, calls, completedTask(), daysAgo(), FarmJob (+9 more)

### Community 131 - "Community 131"
Cohesion: 0.11
Nodes (17): assert, assign(), BotAccount, { createReseller }, DropLog, express, MarketplaceListing, { MongoMemoryServer } (+9 more)

### Community 132 - "Community 132"
Cohesion: 0.13
Nodes (16): cache, cacheKey(), clearCache(), gameName(), inflight, labelCarriesGame(), makeCtx(), MARKETS_NEEDING_CATEGORY (+8 more)

### Community 133 - "Community 133"
Cohesion: 0.17
Nodes (18): boundedInt(), categoryFor(), clampPublicPrice(), cleanText(), finishPublicPrice(), inquiryQuantity(), priceFloor(), priceOptions() (+10 more)

### Community 134 - "Community 134"
Cohesion: 0.14
Nodes (18): APPLY, AvailableAccount, { buildSetGridImage }, { decrypt }, DropSet, engine, log(), main() (+10 more)

### Community 135 - "Community 135"
Cohesion: 0.11
Nodes (14): AF, assert, AutoFarmTask, classes, COLD_START, farm2, FarmJob, FarmLane (+6 more)

### Community 136 - "Community 136"
Cohesion: 0.20
Nodes (15): assert, { buildRadarEvents, splitEventWave }, { mergeWaveItems }, test, buildRadarEvents(), earlier(), eventId(), eventKey() (+7 more)

### Community 137 - "Community 137"
Cohesion: 0.14
Nodes (15): assert, NOW, ONE, {
  parseWave,
  eventKeyFor,
  buildEventCatalog,
  classifyHoldings,
  bundleTitle,
  bundleDescriptionLines,
  bundlePrice,
  lotPrice,
}, PRICING, { splitEventWave }, test, bundlePrice() (+7 more)

### Community 138 - "Community 138"
Cohesion: 0.15
Nodes (11): cache, isOwned(), isOwnedAsync(), killSwitchOn(), normKey(), refresh(), settings, assert (+3 more)

### Community 139 - "Community 139"
Cohesion: 0.14
Nodes (14): ANALYST_BASE, buildAnalystSystem(), callModel(), config, express, isRetryableStatus(), redactIdentifiers(), router (+6 more)

### Community 140 - "Community 140"
Cohesion: 0.13
Nodes (16): ALIAS_TO_KEY, allocator, autoFarmer, AutoFarmTask, express, farmDemand, farmSizing, { logEvent, actorFromReq } (+8 more)

### Community 141 - "Community 141"
Cohesion: 0.11
Nodes (15): APP, APPLY, bc, CFG, DEST, FROM, hosts, { logEvent } (+7 more)

### Community 142 - "Community 142"
Cohesion: 0.12
Nodes (16): ALL, APPLY, args, autoLister, { buildSetGridImage }, copy, fsp, has() (+8 more)

### Community 143 - "Community 143"
Cohesion: 0.16
Nodes (17): APPLY, args, categoryFor(), { classifyKind }, correctedTitle(), evidence, isAutoOwned(), itemCounts() (+9 more)

### Community 144 - "Community 144"
Cohesion: 0.12
Nodes (17): accountListingRoutes, AccountOffer, assert, BotAccount, call(), createOffer(), { decrypt }, express (+9 more)

### Community 145 - "Community 145"
Cohesion: 0.25
Nodes (18): listActivatedTask(), pickDeliveryAccounts(), playerauctionsGameEnabled(), publishEldoradoShare(), publishG2gShare(), publishGgselShare(), publishPlatiShare(), publishPlayerAuctionsShare() (+10 more)

### Community 146 - "Community 146"
Cohesion: 0.22
Nodes (17): AutoFarmTask, BotAccount, botFactory, buildPlan(), collectAutoContainers(), collectNamedContainers(), consolidate(), enabledCount() (+9 more)

### Community 147 - "Community 147"
Cohesion: 0.14
Nodes (18): acquireRunLock(), candForLedger(), endedCampaignKeys(), expirySalePass(), gameCapKey(), lotsMod(), makeCatalogLoader(), mapLimit() (+10 more)

### Community 148 - "Community 148"
Cohesion: 0.14
Nodes (14): a8bdd36 fix(pool): accept a bulk import paste instead of a bare HTTP 413, e7e8241 feat(playerauctions): predictive session reminder + one-click cookie hand-off, assert, copy, farm, fulfiller, mp, proof (+6 more)

### Community 149 - "Community 149"
Cohesion: 0.13
Nodes (12): ACTION_CLASS, actionClass(), classifyDisagreement(), DEMAND_STAGE_DECISIONS, DOWNSTREAM_DECISIONS, EFFECTIVE_DEMAND_DECISIONS, LANE_DECISIONS, laneCanEmit() (+4 more)

### Community 150 - "Community 150"
Cohesion: 0.12
Nodes (11): accountOfferSchema, mongoose, AccountOffer, assert, deps, MarketplaceListing, { MongoMemoryServer }, mongoose (+3 more)

### Community 151 - "Community 151"
Cohesion: 0.12
Nodes (13): mongoose, saleSignalSchema, AF, allocator, assert, autoFarmer, budget, COVERAGE_ON (+5 more)

### Community 152 - "Community 152"
Cohesion: 0.16
Nodes (16): APPLY, args, { buildPromoCoverImage }, BULLETS, copy, description(), farmedGames(), fsp (+8 more)

### Community 153 - "Community 153"
Cohesion: 0.15
Nodes (16): APPLY, AvailableAccount, { buildSetGridImage }, { decrypt }, DropSet, engine, main(), MarketplaceListing (+8 more)

### Community 154 - "Community 154"
Cohesion: 0.18
Nodes (12): assert, { normGame, sameGame }, test, assert, { normGame }, test, normGame(), sameGame() (+4 more)

### Community 155 - "Community 155"
Cohesion: 0.12
Nodes (12): assert, CLOCK, epicnpc, g2gGames, HITS, MISSES, PA_GAME, PA_LEAF (+4 more)

### Community 156 - "Community 156"
Cohesion: 0.12
Nodes (12): AccountOffer, assert, AvailableAccount, BotAccount, deps, { isEncrypted, decrypt }, { MongoMemoryServer }, mongoose (+4 more)

### Community 157 - "Community 157"
Cohesion: 0.15
Nodes (12): { decrypt, encrypt }, epic, EpicAccount, EpicFreebie, pingClaim(), pinged, processAccount(), refreshAccountToken() (+4 more)

### Community 158 - "Community 158"
Cohesion: 0.15
Nodes (15): AvailableAccount, chat, confirmFarmOnG2g(), credentialsFor(), { decrypt }, deliverFarmOrder(), farmAlert, farmMessage() (+7 more)

### Community 159 - "Community 159"
Cohesion: 0.28
Nodes (17): zeusxAttributeValues(), zeusxBaseAttributes(), zeusxDelist(), zeusxGameConfig(), zeusxMyListings(), zeusxOffer(), zeusxOfferUrl(), zeusxPublish() (+9 more)

### Community 160 - "Community 160"
Cohesion: 0.18
Nodes (17): createUnclaimedSet(), dedupeSetItems(), descOpts(), dropKey(), ensureUnclaimedSet(), findUnclaimedSet(), listingDescription(), listingTitle() (+9 more)

### Community 161 - "Community 161"
Cohesion: 0.15
Nodes (13): auditRequest(), { logEvent, actorFromReq }, MUTATING, SKIP_PREFIXES, summarizeBody(), assert, auditRequest, runAudit() (+5 more)

### Community 162 - "Community 162"
Cohesion: 0.13
Nodes (12): epicAccountSchema, mongoose, epicFreebieSchema, mongoose, { encrypt, decrypt }, epic, EpicAccount, epicClaimer (+4 more)

### Community 163 - "Community 163"
Cohesion: 0.17
Nodes (15): APPLY, args, { buildPromoCoverImage }, BULLETS, description(), farmedGames(), fsp, gameDropImages() (+7 more)

### Community 164 - "Community 164"
Cohesion: 0.14
Nodes (15): APPLY, AvailableAccount, { buildSetGridImage }, { decrypt }, DropSet, engine, main(), MarketplaceListing (+7 more)

### Community 165 - "Community 165"
Cohesion: 0.13
Nodes (14): AccountOffer, assert, calls, DropSet, express, MarketplaceListing, { MongoMemoryServer }, mongoose (+6 more)

### Community 166 - "Community 166"
Cohesion: 0.19
Nodes (16): fpCookie(), fpEncode(), fpFieldValue(), fpFormValues(), fpGet(), fpLoadEditor(), fpOfferIds(), fpParseApp() (+8 more)

### Community 167 - "Community 167"
Cohesion: 0.17
Nodes (12): apply(), farmDemand, farmSizing, fleet, { logEvent }, num(), plan(), round1() (+4 more)

### Community 168 - "Community 168"
Cohesion: 0.15
Nodes (13): compare_markets(), _get_catalog(), get_offer_detail(), get_offers(), list_games(), FunPay multi-game marketplace mirror.  Serves a small single page app plus a JSO, Scrape (and cache) the full detail of a single item., Best-effort live price comparison across secondary marketplaces.      Also retur (+5 more)

### Community 169 - "Community 169"
Cohesion: 0.17
Nodes (14): annotate_offers(), _demand_level(), _liquidity(), market_stats(), rank_recommendations(), Resale recommendation engine.  This module turns a list of scraped offers into *, Attach resale metrics to each offer in place.      ``sell_price_usd`` is the pri, Map a G2G units-sold count to a (label, tone) demand rating. (+6 more)

### Community 170 - "Community 170"
Cohesion: 0.13
Nodes (11): BotAccount, express, hosts, { requireAdmin }, router, runner, secretBox, twitchFollow (+3 more)

### Community 171 - "Community 171"
Cohesion: 0.13
Nodes (11): args, DropSet, engine, GAME, { logEvent }, MarketplaceListing, MARKETS, mongoose (+3 more)

### Community 172 - "Community 172"
Cohesion: 0.18
Nodes (14): arg(), FLOORS, gameOf(), has(), itemCountOf(), main(), MarketplaceListing, mongoose (+6 more)

### Community 173 - "Community 173"
Cohesion: 0.13
Nodes (12): assert, DS_PATH, FP_BODY, fs, G2G_BODY, GG_BODY, GG_PATH, html (+4 more)

### Community 174 - "Community 174"
Cohesion: 0.22
Nodes (13): checkClaimState(), crypto, fetchClaimableDrops(), https, INVENTORY_QUERY, JOBS, makeHeaders(), newJobId() (+5 more)

### Community 175 - "Community 175"
Cohesion: 0.18
Nodes (11): classes, compareAccounts(), { hasReuseInputs }, LIVE, NOT_SCORED, AF_FIELDS, buildDecisionInputs(), buildReuseInputs() (+3 more)

### Community 176 - "Community 176"
Cohesion: 0.25
Nodes (13): brain(), classes, FIDELITY, inputsMod, probeGateFor(), probeGateLoadBearing(), reconstructInputs(), replayDecision() (+5 more)

### Community 177 - "Community 177"
Cohesion: 0.16
Nodes (12): mongoose, renterDropSchema, accountMatch(), BotAccount, DropLog, DRY_RUN, main(), migrateRenter() (+4 more)

### Community 178 - "Community 178"
Cohesion: 0.16
Nodes (12): APPLY, args, autoLister, { buildSetGridImage }, fsp, has(), { isNoClaimGame }, itemSignature() (+4 more)

### Community 179 - "Community 179"
Cohesion: 0.14
Nodes (11): accountPoolChecker, accountPoolRoutes, assert, AvailableAccount, { decrypt }, enqueued, express, { MongoMemoryServer } (+3 more)

### Community 180 - "Community 180"
Cohesion: 0.14
Nodes (9): assert, autoFarmer, AutoFarmTask, classes, FarmJob, { MongoMemoryServer }, mongoose, settings (+1 more)

### Community 181 - "Community 181"
Cohesion: 0.15
Nodes (12): accounts(), assert, AutoFarmTask, botFactory, botWaker, executeStep, FarmJob, { MongoMemoryServer } (+4 more)

### Community 182 - "Community 182"
Cohesion: 0.14
Nodes (11): AccountOffer, assert, deps, { encrypt }, MarketplaceListing, { MongoMemoryServer }, mongoose, supplied (+3 more)

### Community 183 - "Community 183"
Cohesion: 0.30
Nodes (13): authFailedFrom(), axios, cleanToken(), followChannel(), gqlError(), gqlRequest(), gqlViaHost(), parseChannelInput() (+5 more)

### Community 184 - "Community 184"
Cohesion: 0.29
Nodes (12): authFailedFrom(), axios, cleanToken(), getGameDropsLive(), getStreamsLive(), gqlError(), gqlRequest(), http() (+4 more)

### Community 185 - "Community 185"
Cohesion: 0.22
Nodes (12): APPLY, args, { brandForGame }, description(), farmedGames(), has(), main(), mongoose (+4 more)

### Community 186 - "Community 186"
Cohesion: 0.22
Nodes (11): APPLY, args, has(), main(), makeStockCounter(), missingOfferState(), money(), mongoose (+3 more)

### Community 187 - "Community 187"
Cohesion: 0.18
Nodes (11): APPLY, args, { buildSetGridImage }, copy, fsp, has(), { isNoClaimGame }, itemSignature() (+3 more)

### Community 188 - "Community 188"
Cohesion: 0.23
Nodes (12): brain(), { buildReuseInputs, withReuseInputs }, executeDecision(), executeReuse(), legacySkipFields(), notify, { recordAutoFarmEvent }, recordSkip() (+4 more)

### Community 189 - "Community 189"
Cohesion: 0.24
Nodes (11): assert, sizing, test, clamp(), coverageTarget(), daysOfCover(), num(), revenueWeight() (+3 more)

### Community 190 - "Community 190"
Cohesion: 0.15
Nodes (6): ACCESS_TOKEN, assert, FRESH_TOKEN, Module, ORDER_ROWS, test

### Community 191 - "Community 191"
Cohesion: 0.15
Nodes (9): assert, fs, FULFILLER, LISTER, MP, path, price, ROUTES (+1 more)

### Community 192 - "Community 192"
Cohesion: 0.15
Nodes (11): assert, DropSet, express, MarketplaceListing, { MongoMemoryServer }, mongoose, mp, PICK (+3 more)

### Community 193 - "Community 193"
Cohesion: 0.24
Nodes (11): assert, daysAgo(), NOW, ok(), {
  recycleEligibility,
  cooldownPassed,
}, test, cooldownPassed(), isRecycledNote() (+3 more)

### Community 194 - "Community 194"
Cohesion: 0.21
Nodes (10): axios, EpicFreebie, fetchFreebies(), fmtWindow(), freeWindow(), normalize(), runOnce(), { sendTelegram } (+2 more)

### Community 195 - "Community 195"
Cohesion: 0.17
Nodes (7): bcrypt, crypto, { encrypt, decrypt }, matchBackupCode(), normalizeBackup(), otplib, QRCode

### Community 196 - "Community 196"
Cohesion: 0.21
Nodes (10): axios, BotAccount, checkStillFollowing(), cleanToken(), gqlLocal(), gqlViaHost(), hosts, secretBox (+2 more)

### Community 197 - "Community 197"
Cohesion: 0.26
Nodes (11): compare_markets(), _g2g_candidates(), g2g_lookup(), _g2g_query(), _manual(), Best-effort live price lookups on secondary marketplaces.  The operator buys ite, Look up live G2G prices for a game, returning a normalised summary., Compare a game's items across the supported secondary marketplaces. (+3 more)

### Community 198 - "Community 198"
Cohesion: 0.20
Nodes (9): fleetSnapshotSchema, mongoose, AvailableAccount, BotAccount, captureSnapshot(), DropLog, FleetSnapshot, groupCount() (+1 more)

### Community 199 - "Community 199"
Cohesion: 0.17
Nodes (8): LIVE, { logEvent }, MarketplaceListing, mongoose, mp, PACE_MS, PREPARE, READERS

### Community 200 - "Community 200"
Cohesion: 0.17
Nodes (8): assert, autoFarmer, AutoFarmTask, FarmJob, { MongoMemoryServer }, mongoose, settings, test

### Community 201 - "Community 201"
Cohesion: 0.17
Nodes (7): assert, chat, fs, FULFILLER, MP, path, test

### Community 202 - "Community 202"
Cohesion: 0.20
Nodes (11): AccountOffer, ALL_PLACEHOLDERS, assert, {
  DEFAULT_TEMPLATE,
  PLACEHOLDERS,
  deliveryText,
  parseSuppliedAccounts,
}, ledgerRow(), offerDoc(), PLAIN, secretBox (+3 more)

### Community 203 - "Community 203"
Cohesion: 0.30
Nodes (11): alreadyInChannel(), chatSessionToken(), dmUrls(), droppedSends, ensureWebSocket(), mp, ourMessageIn(), pickDmChannel() (+3 more)

### Community 204 - "Community 204"
Cohesion: 0.29
Nodes (8): loadRentBots(), loadRentBotsLive(), loadScanStat(), openLogs(), renderBotPager(), stopLogs(), toggleLogs(), wrapScrollInit()

### Community 205 - "Community 205"
Cohesion: 0.25
Nodes (10): args, copy, main(), mp, proof, record(), results, step() (+2 more)

### Community 206 - "Community 206"
Cohesion: 0.20
Nodes (10): APPLY, AvailableAccount, engine, main(), MarketplaceListing, mongoose, mp, ownerKey() (+2 more)

### Community 207 - "Community 207"
Cohesion: 0.36
Nodes (8): assert, {
  heldAccounts,
  stillNeeded,
  mergeProvisioned,
}, test, heldAccounts(), key(), login(), mergeProvisioned(), stillNeeded()

### Community 208 - "Community 208"
Cohesion: 0.22
Nodes (9): assert, { sat, competitionOf, medianPrice }, test, competitionOf(), medianPrice(), relevant(), round1(), sat() (+1 more)

### Community 209 - "Community 209"
Cohesion: 0.25
Nodes (9): assert, daysAgo(), NOW, ok(), {
  spentAccountEligibility,
  cooldownPassed,
  isFarmSpentNote,
}, test, cooldownPassedAt(), isFarmSpentNote() (+1 more)

### Community 210 - "Community 210"
Cohesion: 0.24
Nodes (8): {
  archiveStatusFilter,
  archiveItemKey,
  groupArchiveByItem,
  groupArchiveByGame,
}, assert, test, archiveItemKey(), archiveSource(), archiveStatusFilter(), groupArchiveByGame(), groupArchiveByItem()

### Community 211 - "Community 211"
Cohesion: 0.24
Nodes (5): axios, exchangeAuthCode(), form(), oauthToken(), refresh()

### Community 212 - "Community 212"
Cohesion: 0.25
Nodes (8): buildDeliveryProof(), fsp, os, path, proofSvg(), rows(), sharp, wrap()

### Community 213 - "Community 213"
Cohesion: 0.25
Nodes (10): axios, buildUrl(), fetchJson(), fetchText(), hosts, offloadHost(), piOnline(), probe (+2 more)

### Community 214 - "Community 214"
Cohesion: 0.27
Nodes (11): bundlesMod(), catalogForGames(), catalogForSet(), classificationForSet(), classifyDrops(), dropQty(), dropsFromSet(), expandSetDrops() (+3 more)

### Community 215 - "Community 215"
Cohesion: 0.20
Nodes (7): mongoose, systemEventSchema, express, FleetSnapshot, { requireSuperadmin }, router, SystemEvent

### Community 216 - "Community 216"
Cohesion: 0.20
Nodes (9): backup, express, multer, os, path, { requireSuperadmin }, router, uploadDir (+1 more)

### Community 217 - "Community 217"
Cohesion: 0.24
Nodes (9): ALL, args, categoryFor(), evidence, itemCountOf(), main(), mongoose, pricing (+1 more)

### Community 218 - "Community 218"
Cohesion: 0.20
Nodes (6): APPLY, args, mongoose, mp, PUBLISH_ONLY, REVIVE

### Community 219 - "Community 219"
Cohesion: 0.24
Nodes (9): assert, fs, PAGE, panelSource(), path, PAYLOAD, rendered(), run() (+1 more)

### Community 220 - "Community 220"
Cohesion: 0.24
Nodes (9): assert, hosts, {
  mapWithConcurrency,
  createSeatCounter,
  buildDecisionHostState,
}, test, buildDecisionHostState(), createSeatCounter(), fillExistingBots(), mapWithConcurrency() (+1 more)

### Community 221 - "Community 221"
Cohesion: 0.20
Nodes (7): assert, AutoFarmTask, decideStep, FarmJob, { MongoMemoryServer }, mongoose, test

### Community 222 - "Community 222"
Cohesion: 0.20
Nodes (8): assert, fs, FULFILLER, HEALTH, MODEL, path, SVC, test

### Community 223 - "Community 223"
Cohesion: 0.20
Nodes (8): assert, farm, fs, mp, OFFERS, path, SRC, test

### Community 224 - "Community 224"
Cohesion: 0.40
Nodes (9): bundleDeliveryMessage(), bundleInstruction(), clampInstruction(), credBlock(), credLine(), deliveryMessages(), farmDeliveryMessage(), farmInstruction() (+1 more)

### Community 225 - "Community 225"
Cohesion: 0.31
Nodes (8): buildSnapshot(), cache, evidenceFor(), keyOf(), MarketplaceListing, push(), SaleSignal, snapshot()

### Community 226 - "Community 226"
Cohesion: 0.25
Nodes (7): GAME, JSON_OUT, main(), mongoose, pct(), replay, VERBOSE

### Community 227 - "Community 227"
Cohesion: 0.22
Nodes (6): bundles, DropSet, MarketplaceListing, MarketResearch, mongoose, settings

### Community 228 - "Community 228"
Cohesion: 0.22
Nodes (7): assert, claimFn, ELD, fs, PA, path, test

### Community 229 - "Community 229"
Cohesion: 0.22
Nodes (5): { accountListingText }, assert, DropLog, SET, test

### Community 230 - "Community 230"
Cohesion: 0.44
Nodes (8): band(), classifyKind(), comparableRivals(), COUNT_PATTERNS, isOurs(), parseAdvertisedCount(), recommend(), round2()

### Community 231 - "Community 231"
Cohesion: 0.25
Nodes (6): coworkerMemorySchema, mongoose, config, CoworkerMemory, mongoose, SEED

### Community 232 - "Community 232"
Cohesion: 0.29
Nodes (7): args, bundles, main(), mongoose, NO_STOCK, usd(), VERBOSE

### Community 233 - "Community 233"
Cohesion: 0.29
Nodes (7): APPLY, main(), MarketplaceListing, mongoose, mp, REPLACE, sleep()

### Community 234 - "Community 234"
Cohesion: 0.32
Nodes (7): APPLY, log(), main(), MarketplaceListing, mongoose, mp, sleep()

### Community 235 - "Community 235"
Cohesion: 0.29
Nodes (7): ARCHIVE_ROW, assert, loadGuardian(), Module, shelf(), SUPPLIED_ROW, test

### Community 236 - "Community 236"
Cohesion: 0.25
Nodes (5): assert, { ggselStockField }, LIST_ROW, SINGLE_OFFER, test

### Community 237 - "Community 237"
Cohesion: 0.25
Nodes (7): assert, bundles, PRICING, R6_ITEMS, RIVAL_CODE_RESEARCH, settings, test

### Community 238 - "Community 238"
Cohesion: 0.36
Nodes (7): buildComposeUrl(), composePath(), encodePayload(), nodeForGame(), NODES, NORM_INDEX, normalize()

### Community 239 - "Community 239"
Cohesion: 0.29
Nodes (5): requireAdmin(), express, { requireAdmin }, router, twitchClaim

### Community 242 - "Community 242"
Cohesion: 0.33
Nodes (6): APPLY, main(), MarketplaceListing, mongoose, mp, sleep()

### Community 243 - "Community 243"
Cohesion: 0.33
Nodes (6): APPLY, args, main(), mongoose, mp, norm()

### Community 244 - "Community 244"
Cohesion: 0.38
Nodes (6): args, bar(), has(), main(), mongoose, mp

### Community 245 - "Community 245"
Cohesion: 0.29
Nodes (6): assert, CHAT, fs, FULFILLER, path, test

### Community 246 - "Community 246"
Cohesion: 0.29
Nodes (5): assert, fs, path, SRC, test

### Community 247 - "Community 247"
Cohesion: 0.33
Nodes (5): assert, pageAll(), query(), routes, test

### Community 248 - "Community 248"
Cohesion: 0.29
Nodes (6): assert, fs, MODELS_DIR, mongoose, path, { test }

### Community 249 - "Community 249"
Cohesion: 0.33
Nodes (5): assert, load(), Module, STACKS, test

### Community 250 - "Community 250"
Cohesion: 0.29
Nodes (5): assert, { listingIsLive }, MarketplaceListing, test, listingIsLive()

### Community 251 - "Community 251"
Cohesion: 0.33
Nodes (6): assert, FULL, HEALTHY, load(), Module, test

### Community 252 - "Community 252"
Cohesion: 0.29
Nodes (5): assert, { parseSuppliedAccounts }, test, isEmailish(), parseSuppliedAccounts()

### Community 253 - "Community 253"
Cohesion: 0.29
Nodes (6): assert, { finalizeGgselOffer, GGSEL_STUCK_PREFIX }, pa, test, addUnitToRowLocked(), finalizeGgselOffer()

### Community 254 - "Community 254"
Cohesion: 0.40
Nodes (2): loadBotPicker(), retryLink()

### Community 255 - "Community 255"
Cohesion: 0.60
Nodes (5): fetchAndRender(), fillRenterSelect(), load(), run(), syncFilters()

### Community 256 - "Community 256"
Cohesion: 0.40
Nodes (5): APPLY, empty(), main(), mongoose, REVERT

### Community 257 - "Community 257"
Cohesion: 0.40
Nodes (4): { ARCHIVE_WARMUP_PLAN }, assert, test, ARCHIVE_WARMUP_PLAN

### Community 258 - "Community 258"
Cohesion: 0.33
Nodes (5): assert, fs, path, SRC, test

### Community 259 - "Community 259"
Cohesion: 0.40
Nodes (5): assert, loadWithStubs(), Module, PROFILE_WITH_OWNER, test

### Community 260 - "Community 260"
Cohesion: 0.40
Nodes (5): assert, fakeModel(), loadEngine(), Module, test

### Community 261 - "Community 261"
Cohesion: 0.33
Nodes (5): assert, GGSEL_OWN, GGSEL_RIVALS, mpx, test

### Community 262 - "Community 262"
Cohesion: 0.33
Nodes (4): assert, { freshnessFor, velocityPerWeek }, test, velocityPerWeek()

### Community 263 - "Community 263"
Cohesion: 0.40
Nodes (4): APPLY, fs, mongoose, mp

### Community 264 - "Community 264"
Cohesion: 0.40
Nodes (4): assert, { delistOutcome }, test, delistOutcome()

### Community 265 - "Community 265"
Cohesion: 0.40
Nodes (4): assert, autoLister, test, verify

### Community 266 - "Community 266"
Cohesion: 0.40
Nodes (4): assert, DropSet, { listingGame }, test

### Community 267 - "Community 267"
Cohesion: 0.40
Nodes (4): assert, GGSEL, pricing, test

### Community 268 - "Community 268"
Cohesion: 0.50
Nodes (3): coworkerChatSchema, messageSchema, mongoose

### Community 269 - "Community 269"
Cohesion: 0.50
Nodes (3): mongoose, purchaseItemSchema, purchaseSchema

### Community 270 - "Community 270"
Cohesion: 0.67
Nodes (2): current(), sync()

### Community 271 - "Community 271"
Cohesion: 0.50
Nodes (3): assert, { parseFunpayRows }, test

### Community 272 - "Community 272"
Cohesion: 0.50
Nodes (3): assert, { ggselTitle }, test

### Community 273 - "Community 273"
Cohesion: 0.50
Nodes (3): assert, spentAccounts, test

### Community 274 - "Community 274"
Cohesion: 0.50
Nodes (1): mp

### Community 275 - "Community 275"
Cohesion: 0.50
Nodes (1): mp

### Community 276 - "Community 276"
Cohesion: 0.50
Nodes (1): mp

### Community 277 - "Community 277"
Cohesion: 0.67
Nodes (2): catalogEventSchema, mongoose

### Community 278 - "Community 278"
Cohesion: 0.67
Nodes (2): catalogInquirySchema, mongoose

### Community 279 - "Community 279"
Cohesion: 0.67
Nodes (2): catalogSnapshotSchema, mongoose

### Community 280 - "Community 280"
Cohesion: 0.67
Nodes (2): mongoose, twitchFollowJobSchema

### Community 281 - "Community 281"
Cohesion: 0.67
Nodes (2): mongoose, twitchFollowLogSchema

## Knowledge Gaps
- **3010 isolated node(s):** `js`, `Scraping helpers for FunPay.  This module knows how to do two things:  1. Build`, `Remove upstream brand names / links from user facing text.`, `A single buyable section of a game, e.g. "Twitch Drops".`, `A game on FunPay together with all of its categories.` (+3005 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 254`** (2 nodes): `loadBotPicker()`, `retryLink()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 270`** (2 nodes): `current()`, `sync()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 274`** (1 nodes): `mp`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 275`** (1 nodes): `mp`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 276`** (1 nodes): `mp`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 277`** (2 nodes): `catalogEventSchema`, `mongoose`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 278`** (2 nodes): `catalogInquirySchema`, `mongoose`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 279`** (2 nodes): `catalogSnapshotSchema`, `mongoose`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 280`** (2 nodes): `mongoose`, `twitchFollowJobSchema`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 281`** (2 nodes): `mongoose`, `twitchFollowLogSchema`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `logEvent()` connect `Community 5` to `Community 161`, `Community 74`, `Community 93`, `Community 14`, `Community 140`, `Community 11`, `Community 44`, `Community 67`, `Community 119`, `Community 171`, `Community 37`, `Community 199`, `Community 19`, `Community 143`, `Community 53`, `Community 30`, `Community 99`, `Community 78`, `Community 22`, `Community 77`, `Community 35`, `Community 54`, `Community 18`, `Community 2`, `Community 32`, `Community 31`, `Community 167`, `Community 10`, `Community 55`?**
  _High betweenness centrality (0.006) - this node is a cross-community bridge._
- **Why does `BudgetCycle` connect `Community 50` to `Community 86`, `Community 121`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **Why does `requireSuperadmin()` connect `Community 2` to `Community 93`, `Community 45`, `Community 215`, `Community 16`, `Community 216`, `Community 48`, `Community 33`, `Community 17`, `Community 118`, `Community 14`, `Community 162`, `Community 27`, `Community 140`, `Community 84`, `Community 11`, `Community 44`, `Community 57`, `Community 52`, `Community 12`, `Community 70`, `Community 19`, `Community 49`, `Community 113`, `Community 67`, `Community 4`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **What connects `js`, `Scraping helpers for FunPay.  This module knows how to do two things:  1. Build`, `Remove upstream brand names / links from user facing text.` to the rest of the system?**
  _3010 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.08307973219720025 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.05345293683951831 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.020128599384959464 - nodes in this community are weakly interconnected._