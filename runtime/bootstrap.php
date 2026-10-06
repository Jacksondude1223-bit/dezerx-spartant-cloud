<?php
$app = require __DIR__.'/spartan-app.php';
require_once '/usr/local/lib/spartan-cloud/SpartanCloudServiceProvider.php';
$app->register(SpartanCloud\SpartanCloudServiceProvider::class);
return $app;
