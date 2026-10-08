<?php
require '/usr/local/lib/spartan-cloud/domain-context.php';

foreach (['https://billing.customer.test', 'https://other.customer.test/'] as $url) {
    putenv('APP_URL='.$url);
    $_SERVER['HTTP_HOST'] = 'node-us.provider.test';
    $_SERVER['SERVER_NAME'] = 'localhost';
    SpartanCloud\initializeDomainContext();
    $expected = parse_url($url, PHP_URL_HOST);
    foreach (['HTTP_HOST', 'SERVER_NAME', 'HTTP_X_FORWARDED_HOST'] as $key) {
        if ($_SERVER[$key] !== $expected) {
            throw new RuntimeException('console_domain_mismatch');
        }
    }
    if ($_SERVER['HTTPS'] !== 'on' || $_SERVER['SERVER_PORT'] !== '443' || $_SERVER['REQUEST_SCHEME'] !== 'https') {
        throw new RuntimeException('console_scheme_mismatch');
    }
}
foreach (['', 'http://billing.customer.test', 'https://user@billing.customer.test', 'https://billing.customer.test:8443', 'https://billing.customer.test/path', 'https://billing.customer.test?x=1'] as $url) {
    putenv('APP_URL='.$url);
    try {
        SpartanCloud\initializeDomainContext();
    } catch (RuntimeException $error) {
        continue;
    }
    throw new RuntimeException('invalid_console_url_accepted');
}
echo "console_domain_context_ok\n";
