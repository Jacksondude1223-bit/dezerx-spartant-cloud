<?php
namespace SpartanCloud;

function initializeDomainContext(): void
{
    if (PHP_SAPI !== 'cli') {
        return;
    }
    $url = getenv('APP_URL');
    $parts = is_string($url) ? parse_url($url) : false;
    if (!is_array($parts) || ($parts['scheme'] ?? '') !== 'https' || !isset($parts['host']) || !preg_match('/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/', $parts['host']) || isset($parts['user']) || isset($parts['pass']) || isset($parts['port']) || isset($parts['query']) || isset($parts['fragment']) || !in_array($parts['path'] ?? '', ['', '/'], true)) {
        throw new \RuntimeException('invalid_application_url');
    }
    $host = $parts['host'];
    $_SERVER['HTTP_HOST'] = $host;
    $_SERVER['SERVER_NAME'] = $host;
    $_SERVER['HTTPS'] = 'on';
    $_SERVER['SERVER_PORT'] = '443';
    $_SERVER['REQUEST_SCHEME'] = 'https';
    $_SERVER['HTTP_X_FORWARDED_HOST'] = $host;
    $_SERVER['HTTP_X_FORWARDED_PROTO'] = 'https';
    $_SERVER['HTTP_X_FORWARDED_PORT'] = '443';
}
