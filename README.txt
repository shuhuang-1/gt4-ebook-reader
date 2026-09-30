GT4 Reader - Overlay Package
============================

HOW TO USE (3 steps)
--------------------
1. Extract this zip.
2. Copy ALL contents into your project root, OVERWRITING when asked.
   Example:  E:\cpp_code\MyApplication2\
   (If your project is MyApplication, use that folder instead.)
3. Open DevEco Studio -> Sync Now -> Build -> Build Hap(s)

WHAT GETS OVERWRITTEN
---------------------
  entry\src\                 <- full source (bookshelf + reader pages)
  build-profile.json5         <- API 6 (matches your installed SDK)
  package.json                <- emptied (stops npm ETARGET errors)

WHAT IS PRESERVED (safe)
------------------------
  .idea\                     <- DevEco project files
  local.properties
  hvigorfile.ts
  entry\hvigorfile.ts (if any)
  So the project still opens normally in DevEco.

NOTE
----
  js folder name is "mainability" - matches your project.
  config.json already registers BOTH pages:
      pages/index/index   (bookshelf)
      pages/detail/detail (reader)

OUTPUT
------
  entry\build\outputs\hap\debug\liteWearable\  ->  *-signed.hap
