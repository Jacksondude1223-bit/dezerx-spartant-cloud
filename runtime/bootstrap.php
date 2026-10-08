<?php
require_once '/usr/local/lib/spartan-cloud/domain-context.php';
SpartanCloud\initializeDomainContext();
$app = require __DIR__.'/spartan-app.php';
require_once '/usr/local/lib/spartan-cloud/SpartanCloudServiceProvider.php';
$app->register(SpartanCloud\SpartanCloudServiceProvider::class);
return $app;
